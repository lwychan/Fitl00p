// Scheduled nightly (cron 02:30 + 03:30 UTC; acts only when it's 03:xx in
// London, so once a night across DST). For each diabetes-enabled user with a
// Nightscout URL: pull Nightscout, score every finished episode not already
// stored (corrections, meals, workouts, nights — DiabetesEngine.episodesToScore),
// store them in dx_episodes (written once, never updated), refit the model
// from the last 180 days of stored episodes and insert it into dx_model.
//
// Backfill: while a user has no model, each run scores the next
// BACKFILL_CHUNK_DAYS of history (from 90 days back / the newest stored
// episode). Episodes are stored per chunk, but no dx_model row is written until
// a chunk reaches now — a model from partial history is never stored (and
// asModel ignores one with learn.backfillComplete false). After that, each night
// re-reads the last NIGHTLY_DAYS (stored episodes are skipped by key).
//
// Safety: if Nightscout can't be reached, lost its treatments, hit a count=
// ceiling, or (tonight's run) has less than 12h of CGM in the last 24h, the user
// is skipped and NOTHING is written or deleted — the previous model stays in
// force (the app falls back to pump settings once it is 48h old).
//
// `?force=1` bypasses the London-hour guard (first run / manual rerun). It is
// anon-callable: the response is only { ok }, details go to the function logs;
// a user whose model is < 15 min old is skipped, and no model row is added when
// nothing new was stored and the model is < 1h old.
//
// CPU: Edge Functions get ~2 s CPU per request. Each run scores at most
// MAX_EPISODES_PER_RUN episodes, the model is written before the forecast-bias
// replay (the costliest step, on FORECAST_BIAS_DAYS) and the bias is patched in
// afterwards — so a CPU kill there keeps the model.

import { sbFetch, londonNow, londonDateStrOf, GEMMA_USER_ID } from '../_shared/webpush.ts';
import DiabetesEngine from '../_shared/diabetes-engine.js';
import ReadinessModel from '../_shared/readiness-model.js';
import SettingsReview from '../_shared/settings-review.js';
import { fetchNightscoutInput } from '../_shared/nightscout-fetch.ts';

const SB_URL = Deno.env.get('SUPABASE_URL');
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const LEARN_HOUR_LONDON = 3;
const BACKFILL_DAYS = 90;             // history learned on the first runs
const BACKFILL_CHUNK_DAYS = 10;       // ...this many days per run
const NIGHTLY_DAYS = 6;               // once backfilled; covers the bias replay window
const EPISODE_WINDOW_DAYS = 180;      // episodes fitModel learns from
const MODEL_KEEP_DAYS = 60;           // dx_model history kept (plus the newest)
const MAX_EPISODES_PER_RUN = 250;     // CPU cap per user per run
const FORECAST_BIAS_DAYS = 5;         // ~15 hourly checks per 3h block (n >= 10 needed)
const MAX_CHUNKS_PER_RUN = 10;            // empty chunks (before the data starts) passed per run
const FORCE_MIN_INTERVAL_MS = 15 * 60000; // ?force=1 skips a user whose model is this fresh
const MODEL_REFIT_MIN_MS = 3600000;       // no new episodes + a model this fresh -> no new row
const DAY = 86400000;

const HEADERS = { 'Content-Type': 'application/json' };

async function sbWrite(path: string, method: string, body: unknown, prefer = 'return=minimal') {
  const res = await fetch(`${SB_URL}${path}`, {
    method,
    headers: { apikey: SB_SERVICE!, Authorization: `Bearer ${SB_SERVICE}`, 'Content-Type': 'application/json', Prefer: prefer },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} → ${res.status}: ${await res.text()}`);
}

// PostgREST caps a response at 1000 rows; page through.
async function sbFetchAll(path: string, page = 1000): Promise<any[]> {
  const out: any[] = [];
  for (let offset = 0; ; offset += page) {
    const { ok, data } = await sbFetch(`${path}&limit=${page}&offset=${offset}`);
    if (!ok) throw new Error(`GET ${path.split('?')[0]} failed`);
    out.push(...(data as any[]));
    if ((data as any[]).length < page) return out;
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

// Same three sources and shapes as fetchDxWorkouts() in src/app.js.
const MANUAL_ACTIVITY_LABELS: Record<string, string> = { swim: 'Swim', walk: 'Walk', run: 'Run', strength: 'Strength', other: 'Other' };
async function loadWorkouts(userId: string, sinceMs: number, untilMs: number) {
  const since = iso(sinceMs), until = iso(untilMs);
  const [sessions, apple, manual] = await Promise.all([
    sbFetchAll(`/rest/v1/workout_sessions?user_id=eq.${userId}&created_at=gte.${since}&created_at=lte.${until}&select=split_type,started_at,created_at&order=created_at`),
    sbFetchAll(`/rest/v1/apple_health_workouts?user_id=eq.${userId}&started_at=gte.${since}&started_at=lte.${until}&select=workout_type,started_at,ended_at,avg_heart_rate&order=started_at`),
    sbFetchAll(`/rest/v1/manual_activities?user_id=eq.${userId}&started_at=gte.${since}&started_at=lte.${until}&select=activity_type,started_at,ended_at,unplugged&order=started_at`),
  ]);
  return [
    ...sessions.map(w => ({ startTime: w.started_at || w.created_at, endTime: w.created_at, workoutType: w.split_type || 'Other' })),
    ...apple.map(w => ({ startTime: w.started_at, endTime: w.ended_at, workoutType: w.workout_type, avgHr: w.avg_heart_rate ?? undefined })),
    ...manual.map(w => ({ startTime: w.started_at, endTime: w.ended_at,
      workoutType: MANUAL_ACTIVITY_LABELS[w.activity_type] || w.activity_type, unplugged: !!w.unplugged })),
  ];
}

// Same shape as fetchMacroMealLog() in src/app.js.
async function loadMacroMeals(userId: string, sinceMs: number, untilMs: number) {
  const rows = await sbFetchAll(`/rest/v1/diabetes_meals?user_id=eq.${userId}&eaten_at=gte.${iso(sinceMs)}&eaten_at=lte.${iso(untilMs)}` +
    '&select=eaten_at,meal_name,carbs_g,fat_g,protein_g,matched_bolus_time&order=eaten_at');
  return rows.map(r => ({
    time: new Date(r.eaten_at).getTime(), mealName: r.meal_name || null,
    carbs: Number(r.carbs_g), fat: Number(r.fat_g), protein: Number(r.protein_g),
    matched_bolus_time: r.matched_bolus_time || null,
  }));
}

// health(ms) for episodeContext: that London day's resting-HR z-score (vs the
// previous 30 days, as the Body Battery card does) and sleep hours. Before
// 06:00 the last completed night is the previous day's row (log_date = wake date).
const londonDateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
async function loadHealth(userId: string, sinceMs: number) {
  const hist = await sbFetchAll(`/rest/v1/health_daily?user_id=eq.${userId}&log_date=gte.${iso(sinceMs - 35 * DAY).slice(0, 10)}` +
    '&select=log_date,resting_hr,sleep_total_hrs&order=log_date');
  const byDate = new Map(hist.map(h => [h.log_date, h]));
  const cache = new Map<string, any>();
  return (ms: number) => {
    const day = londonDateFmt.format(new Date(ms - 6 * 3600000));
    if (cache.has(day)) return cache.get(day);
    const row = byDate.get(day);
    let v = null;
    if (row) {
      const rhr = row.resting_hr != null ? Number(row.resting_hr) : null;
      const stats = rhr != null ? ReadinessModel.personalBaseline(hist, 'resting_hr', day) : null;
      v = {
        rhrZ: stats && rhr != null ? (rhr - stats.mean) / Math.max(stats.sd, 1) : null,
        sleepHrs: row.sleep_total_hrs != null ? Number(row.sleep_total_hrs) : null,
        restingHr: rhr,
      };
    }
    cache.set(day, v);
    return v;
  };
}

// Fetch + score + store one window [fromMs, untilMs ?? now]. A skip result
// means nothing was written.
// Daily mean CGM glucose -> health_daily.glucose_avg_mmol (the dashboard Glucose tile and the
// estimated HbA1c read it; it used to come from Health Auto Export, removed 2026-09-15).
// Only days with >= 4h of readings; the in-progress day is refreshed every run.
async function writeDailyGlucose(userId: string, readings: any[]) {
  const byDay: Record<string, number[]> = {};
  for (const r of readings || []) {
    if (!Number.isFinite(r?.time) || !Number.isFinite(r?.value)) continue;
    (byDay[londonDateStrOf(new Date(r.time))] ||= []).push(r.value);
  }
  const rows = Object.entries(byDay).filter(([, v]) => v.length >= 48)
    .map(([log_date, v]) => ({ user_id: userId, log_date, glucose_avg_mmol: Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 }));
  if (rows.length) await sbWrite('/rest/v1/health_daily?on_conflict=user_id,log_date', 'POST', rows, 'resolution=merge-duplicates,return=minimal');
}

async function scoreWindow(profile: any, pumpProfile: any, prevModel: any, fromMs: number, untilMs: number | null, nowMs: number) {
  const userId = profile.id;
  const endMs = untilMs ?? nowMs;
  const ns = await fetchNightscoutInput(profile, { days: (endMs - fromMs) / DAY, untilMs });
  if (!ns) return { skip: 'nightscout-unreachable' };
  try { await writeDailyGlucose(userId, ns.glucoseHistory); } catch (e) { console.error('daily glucose:', (e as Error).message); }
  if (!ns.fetchInfo?.treatmentsOk) return { skip: 'treatments-fetch-failed' };
  if (ns.fetchInfo.truncated) return { skip: 'fetch-hit-count-limit' };
  // Tonight's data must be there (a past backfill chunk may legitimately be thin or empty).
  if (untilMs == null && !DiabetesEngine.shouldLearn(ns, nowMs)) return { skip: 'under-12h-cgm-in-24h' };

  const [workouts, macroMealLog, health, storedRows] = await Promise.all([
    loadWorkouts(userId, fromMs - 2 * DAY, endMs),
    loadMacroMeals(userId, fromMs, endMs),
    loadHealth(userId, fromMs),
    sbFetchAll(`/rest/v1/dx_episodes?user_id=eq.${userId}&start_at=gte.${iso(fromMs)}&select=kind,start_at&order=start_at`),
  ]);
  const storedKeys = new Set(storedRows.map(r => `${r.kind}|${new Date(r.start_at).getTime()}`));

  // Carbs come from the pump boluses; a fitl00p meal row only corrects the bolus
  // it was linked to (matched_bolus_time). Unlinked rows are NOT added as extra
  // carb entries the way the app's merge does: on Lewis's data most unlinked rows
  // duplicate a pump-logged meal, which made ~80% of meals 'stacked-meal' (first
  // run, 2026-11-05: 1 clean meal of 484). They still supply macros (fat/protein).
  const input = {
    ...ns,
    boluses: DiabetesEngine.mergeMealCarbsIntoBoluses(ns.boluses, macroMealLog.filter(m => m.matched_bolus_time)),
    activities: { workouts },
    macroMealLog,
  };
  const episodes = DiabetesEngine.episodesToScore(DiabetesEngine.prepareLearningInput(input), storedKeys, nowMs, {
    pumpProfile, model: prevModel, siteChanges: ns.siteChanges, health, maxEpisodes: MAX_EPISODES_PER_RUN,
  });
  const byKind: Record<string, number> = {};
  const rows = episodes.map((ep: any) => {
    byKind[ep.kind] = (byKind[ep.kind] || 0) + 1;
    return { user_id: userId, kind: ep.kind, start_at: iso(ep.startMs), episode: ep };
  });
  for (let i = 0; i < rows.length; i += 200) {
    await sbWrite('/rest/v1/dx_episodes?on_conflict=user_id,kind,start_at', 'POST', rows.slice(i, i + 200),
      'resolution=ignore-duplicates,return=minimal');
  }
  return { input, macroMealLog, scored: episodes.length, byKind, truncated: episodes.length >= MAX_EPISODES_PER_RUN, fetched: ns.fetchInfo };
}

async function learnUser(profile: any, nowMs: number, force: boolean) {
  const userId = profile.id;
  const t0 = performance.now();
  const lap = (label: string) => console.log(`diabetes-learn ${String(userId).slice(0, 8)} ${label} @${Math.round(performance.now() - t0)}ms`);
  const pumpProfile = profile.diabetes_pump_profile;
  if (!pumpProfile?.default?.length) return { status: 'skipped', reason: 'no-pump-profile' };

  // Only complete models are stored, so the newest row (if any) is one.
  const { data: prevRows } = await sbFetch(`/rest/v1/dx_model?user_id=eq.${userId}&select=fitted_at,model&order=fitted_at.desc&limit=1`);
  const prevRow = (prevRows as any[])?.[0] ?? null;
  const prevModel = DiabetesEngine.asModel(prevRow?.model) ? prevRow.model : null;
  const prevAgeMs = prevRow ? nowMs - new Date(prevRow.fitted_at).getTime() : Infinity;
  if (force && prevAgeMs < FORCE_MIN_INTERVAL_MS) return { status: 'skipped', reason: 'forced-too-soon' };
  const backfilling = !prevModel;

  // Backfill (no model yet): 10-day chunks from just before the newest stored
  // episode (or 90 days back), a day of overlap so episodes cut off at a chunk's
  // end are scored by the next. Empty chunks (before the data starts) are passed
  // within the same run. No model is written until a chunk reaches now.
  // Nightly: the last NIGHTLY_DAYS up to now.
  let scored = 0;
  const byKind: Record<string, number> = {};
  let last: any = null, complete = false, fromMs = 0;
  if (backfilling) {
    const { data: newest } = await sbFetch(`/rest/v1/dx_episodes?user_id=eq.${userId}&select=start_at&order=start_at.desc&limit=1`);
    let cursor = (newest as any[])?.[0] ? new Date((newest as any[])[0].start_at).getTime() : nowMs - BACKFILL_DAYS * DAY;
    for (let i = 0; i < MAX_CHUNKS_PER_RUN; i++) {
      fromMs = cursor - DAY;
      const end = fromMs + (BACKFILL_CHUNK_DAYS + 1) * DAY;
      const untilMs = end >= nowMs ? null : end;
      // the last chunk also feeds the forecast-bias replay, which needs NIGHTLY_DAYS
      if (untilMs == null) fromMs = Math.min(fromMs, nowMs - NIGHTLY_DAYS * DAY);
      last = await scoreWindow(profile, pumpProfile, null, fromMs, untilMs, nowMs);
      if (last.skip) return { status: 'skipped', reason: last.skip, backfilling };
      scored += last.scored;
      for (const [k, v] of Object.entries(last.byKind)) byKind[k] = (byKind[k] || 0) + (v as number);
      lap(`chunk ${iso(fromMs).slice(0, 10)} scored ${last.scored}`);
      if (untilMs == null) { complete = !last.truncated; break; }
      if (last.scored > 0) break;          // one chunk with data per run (CPU)
      cursor = end;
    }
    if (!complete) return { status: 'backfilling', scored, byKind };
  } else {
    fromMs = nowMs - NIGHTLY_DAYS * DAY;
    last = await scoreWindow(profile, pumpProfile, prevModel, fromMs, null, nowMs);
    if (last.skip) return { status: 'skipped', reason: last.skip, backfilling };
    scored = last.scored;
    Object.assign(byKind, last.byKind);
    // nothing new and a model less than an hour old: keep it
    if (scored === 0 && prevAgeMs < MODEL_REFIT_MIN_MS) return { status: 'unchanged', scored };
  }
  lap(`scored ${scored}`);

  const all = await sbFetchAll(`/rest/v1/dx_episodes?user_id=eq.${userId}&start_at=gte.${iso(nowMs - EPISODE_WINDOW_DAYS * DAY)}&select=episode&order=start_at`);
  const stored = all.map(r => r.episode);
  const model: any = DiabetesEngine.fitModel(stored, pumpProfile, { nowMs, prevModel });
  // keep the previous bias until it is recomputed below
  model.forecastBias = Array.isArray(prevModel?.forecastBias) ? prevModel.forecastBias : [];
  model.learn = { backfillComplete: true, scored, byKind };
  // Settings review (ISF / carb ratio / overnight basal by time of day) — recomputed
  // below again once the forecast bias is in.
  const reviewNow = () => SettingsReview.settingsReview({ model, nights: stored.filter((e: any) => e?.kind === 'night'), pumpProfile, nowMs });
  model.review = reviewNow();
  lap(`fitted from ${stored.length}`);

  // Written BEFORE the forecast-bias replay (the costliest step), so running
  // out of CPU there still leaves tonight's fitted model in place.
  const fittedAt = iso(model.fittedAt);
  await sbWrite('/rest/v1/dx_model', 'POST', { user_id: userId, fitted_at: fittedAt, model, episodes_used: stored.length });
  await sbWrite(`/rest/v1/dx_model?user_id=eq.${userId}&fitted_at=lt.${iso(Math.min(nowMs - MODEL_KEEP_DAYS * DAY, model.fittedAt - 1))}`, 'DELETE', undefined);

  const { input, macroMealLog } = last;
  const from = nowMs - (FORECAST_BIAS_DAYS + 1) * DAY;   // + a day of history for the first forecasts
  const recent = (xs: any[]) => (xs || []).filter(x => new Date(x.time).getTime() >= from);
  model.forecastBias = DiabetesEngine.forecastAccuracyByBlock({
    ...input,
    glucoseHistory: recent(input.glucoseHistory), boluses: recent(input.boluses),
    corrections: recent(input.corrections), basalDoses: recent(input.basalDoses),
    macroMealLog: recent(macroMealLog), model,
  }, nowMs);
  lap('forecast bias');
  model.review = reviewNow();
  await sbWrite(`/rest/v1/dx_model?user_id=eq.${userId}&fitted_at=eq.${fittedAt}`, 'PATCH', { model });

  return { status: 'learned', backfilling, scored, byKind, episodesUsed: stored.length, fittedAt, ms: Math.round(performance.now() - t0) };
}

Deno.serve(async (req: Request) => {
  if (!SB_URL || !SB_SERVICE) return new Response(JSON.stringify({ ok: false }), { status: 500, headers: HEADERS });
  const force = new URL(req.url).searchParams.get('force') === '1';
  const { hour } = londonNow();
  if (!force && hour !== LEARN_HOUR_LONDON) {
    console.log(`diabetes-learn: London hour ${hour}, runs at ${LEARN_HOUR_LONDON}`);
    return new Response(JSON.stringify({ ok: true }), { headers: HEADERS });
  }

  const { data: profiles } = await sbFetch(
    '/rest/v1/profiles?diabetes_enabled=eq.true&diabetes_ns_url=not.is.null' +
    '&select=id,diabetes_ns_url,diabetes_ns_token,diabetes_ns_secret,diabetes_target_low,diabetes_target_high,diabetes_ideal_target,' +
    'diabetes_carb_ratio,diabetes_correction_factor,diabetes_insulin_peak_min,diabetes_insulin_duration_min,diabetes_pump_profile'
  );
  const nowMs = Date.now();
  const results: any[] = [];
  for (const profile of (profiles as any[]) || []) {
    if (profile.id === GEMMA_USER_ID) continue;   // no diabetes data
    const user = String(profile.id).slice(0, 8);
    try {
      results.push({ user, ...(await learnUser(profile, nowMs, force)) });
    } catch (err) {
      // a failed write mid-run leaves the previous model in place
      results.push({ user, status: 'error', error: (err as Error).message.slice(0, 300) });
    }
  }
  // Details go to the function logs only: the endpoint is anon-callable.
  console.log(JSON.stringify({ forced: force, results }));
  const ok = results.every(r => r.status !== 'error');
  return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 500, headers: HEADERS });
});
