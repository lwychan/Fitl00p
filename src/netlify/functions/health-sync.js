// netlify/functions/health-sync.js
// Receives Apple Health data from Health Auto Export app.
// Auth: Bearer <api_key> header.
// Payload format: https://github.com/Lybron/health-auto-export/wiki/API-Export---JSON-Format
//
// FIX (2026-06-30): Active/Resting/Dietary Energy were being OVERWRITTEN by
// the last sample processed instead of summed. Confirmed via raw_payload
// diagnostic capture that Health Auto Export sends individual samples per
// metric — e.g. dietary_energy arrives as one entry per MyFitnessPal meal
// log (sampleCount: 32 for one day), and active/basal energy arrive as
// per-minute Apple Watch readings (sampleCount: 6000-9000+ for one day).
// These now accumulate across all samples for a given log_date, the same
// way step_count already did. The diagnostic raw_payload capture has been
// removed now that the root cause is confirmed and fixed.

const crypto = require('crypto');
const { sendWebPush } = require('./_lib/webpush');

const SB_URL     = process.env.SUPABASE_URL;
const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'POST only' }) };
  }

  // ── 1. Authenticate ───────────────────────────────────────
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (!token) {
    return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Missing Authorization header' }) };
  }

  if (!SB_URL || !SB_SERVICE) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Server not configured' }) };
  }

  const keyHash = crypto.createHash('sha256').update(token).digest('hex');
  const keyRes  = await sbFetch(`/rest/v1/health_api_keys?key_hash=eq.${keyHash}&select=user_id,id`);

  if (!keyRes.ok || !keyRes.data?.length) {
    return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Invalid API key' }) };
  }

  const { user_id, id: keyId } = keyRes.data[0];

  // Update last_used (fire and forget)
  sbFetch(`/rest/v1/health_api_keys?id=eq.${keyId}`, 'PATCH', { last_used: new Date().toISOString() });

  // Some users log weight manually in the fitl00p front end instead of
  // trusting Apple Health/MyFitnessPal for it (e.g. a synced value from
  // an old smart-scale entry, or MFP's own weight log conflicting with
  // what they actually enter) — for them the Body Weight metric below is
  // parsed but never written, so an automatic sync can never clobber a
  // manual entry with a stale or unwanted figure.
  const profRes = await sbFetch(`/rest/v1/profiles?id=eq.${user_id}&select=manual_weight_logging`);
  const ignoreWeight = profRes.ok && profRes.data?.[0]?.manual_weight_logging === true;

  // ── 2. Parse body ─────────────────────────────────────────
  let body;
  try {
    const raw = event.body || '';
    body = JSON.parse(raw);
  } catch (e) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON: ' + e.message }) };
  }

  // Health Auto Export format: { data: { metrics: [...], workouts: [...] } }
  const metrics  = body?.data?.metrics  || [];
  const workouts = body?.data?.workouts || [];

  if (!metrics.length && !workouts.length) {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ received: 0, processed: 0, message: 'No metrics or workouts in payload' }) };
  }

  // Grouped by date and shared between the workouts loop below (for
  // heart-rate-recovery, the only per-workout field that feeds a daily
  // score rather than apple_health_workouts itself) and the daily-metrics
  // loop further down. Declared here, before either loop, so a sync call
  // carrying only a Workouts payload (Health Auto Export's Health Data
  // and Workouts exports are two separate automations, commonly sent as
  // two separate calls — see the early-return fix below) can still
  // populate and upsert it.
  const byDate = {};

  // Raw timestamped samples for step count + heart rate, collected
  // alongside the per-date sums below — feeds detectUndetectedActivity()
  // further down, which needs the actual time series (not just a daily
  // total) to find a burst of elevated HR + dense steps that Apple
  // Health itself never logged as a Workout. Dateless/absolute-time on
  // purpose: binning by absolute ms sidesteps day-boundary edge cases
  // (a walk spanning midnight) that a per-calendar-day bucket would hit.
  const activitySamples = { steps: [], hr: [] };

  // ── Discrete workout events ────────────────────────────────
  // Separate from the daily-aggregate loop below — these carry their own
  // real start/end times (the daily metrics above never do), which is
  // exactly what the diabetes engine's post-exercise window logic needs
  // and previously never had, despite this array always being present
  // in the payload whenever Health Auto Export's "Workouts" export type
  // is turned on. Dedup on (user_id, external_id): Health Auto Export
  // re-sends a rolling window of past workouts on every automated sync,
  // not just new ones since last time.
  let workoutsProcessed = 0;
  for (const w of workouts) {
    const start = w.start, end = w.end;
    if (!start || !end) continue;
    const externalId = w.id ? String(w.id) : `${w.name || 'workout'}_${start}`;
    const maxHr = w.maxHeartRate?.qty != null ? round1(Number(w.maxHeartRate.qty)) : null;
    const row = {
      user_id,
      external_id: externalId,
      workout_type: w.name || 'Workout',
      started_at: new Date(start).toISOString(),
      ended_at: new Date(end).toISOString(),
      duration_min: w.duration != null ? round1(Number(w.duration) / 60) : null,
      active_energy_kcal: qtyToKcal(w.activeEnergyBurned),
      total_energy_kcal: qtyToKcal(w.totalEnergy),
      distance_km: qtyToKm(w.distance),
      avg_heart_rate: w.avgHeartRate?.qty != null ? round1(Number(w.avgHeartRate.qty)) : null,
      max_heart_rate: maxHr,
      synced_at: new Date().toISOString(),
    };
    const res = await sbFetch(
      '/rest/v1/apple_health_workouts?on_conflict=user_id,external_id',
      'POST', row,
      { 'Prefer': 'resolution=merge-duplicates,return=minimal' }
    );
    if (res.ok) workoutsProcessed++;

    // ── Heart Rate Recovery ────────────────────────────────
    // HealthKit's heartRateRecoveryOneMinute (watchOS 11+/Ultra 2+) —
    // Health Auto Export sends it as a short time-series of {date,qty}
    // samples taken across the recovery window right after the workout
    // ends, not a single value, so the drop is derived: peak HR during
    // the workout (maxHeartRate, falling back to the recovery array's
    // own first sample if that's missing) minus the lowest point reached
    // during the sampled recovery window. A fitness marker (how fast the
    // autonomic nervous system disengages), not a same-day readiness
    // signal the way HRV is — deliberately kept out of the Recovery
    // score for that reason and surfaced as its own health tile instead.
    // Best (highest) value of the day wins if there were multiple workouts.
    if (Array.isArray(w.heartRateRecovery) && w.heartRateRecovery.length >= 2) {
      const samples = w.heartRateRecovery.map(p => Number(p.qty)).filter(n => Number.isFinite(n));
      if (samples.length >= 2) {
        const peakHr = maxHr ?? samples[0];
        const hrr = Math.round(peakHr - Math.min(...samples));
        if (hrr > 0) {
          const workoutDate = row.started_at.slice(0, 10);
          if (!byDate[workoutDate]) byDate[workoutDate] = {};
          byDate[workoutDate].hr_recovery_bpm = Math.max(byDate[workoutDate].hr_recovery_bpm || 0, hrr);
        }
      }
    }
  }

  if (!metrics.length && !Object.keys(byDate).length) {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ received: 0, processed: 0, workoutsProcessed, message: 'No metrics in payload' }) };
  }

  // ── 3. Group all metric data points by date ───────────────
  // (byDate itself declared earlier, above the workouts loop — see comment there)

  for (const metric of metrics) {
    const metricName  = (metric.name  || '').toLowerCase().replace(/\s+/g, '_');
    const metricUnits = (metric.units || '').toLowerCase();
    const dataPoints  = metric.data   || [];

    for (const item of dataPoints) {
      // Date field: "2024-01-15 08:30:00 +0000" — take first 10 chars
      const rawDate = item.date || '';
      const logDate = rawDate.substring(0, 10);
      if (!logDate || logDate.length < 10 || !logDate.match(/^\d{4}-\d{2}-\d{2}$/)) continue;

      if (!byDate[logDate]) byDate[logDate] = {};
      const d = byDate[logDate];

      // ── Sleep Analysis ──────────────────────────────────
      // Fields: asleep, inBed, sleepStart, sleepEnd
      // With summarise ON and phases enabled: deep, core, rem, awake fields appear
      if (metricName.includes('sleep')) {
        // Sleep phases (present when "Include Sleep Phases" enabled in app)
        if (item.deep     != null) d.sleep_deep_hrs  = round2(item.deep);
        if (item.rem      != null) d.sleep_rem_hrs   = round2(item.rem);
        if (item.core     != null) d.sleep_core_hrs  = round2(item.core);

        // Total sleep — prefer the "asleep" field when present, but it has
        // been observed to be missing/zero from Health Auto Export even
        // when phase data (deep/rem/core) arrives correctly in the same
        // payload. Deep + REM + Core is the same quantity "asleep" would
        // represent (total time actually asleep, excluding awake periods),
        // so derive it from the phases as a fallback rather than leaving
        // total sleep at 0 whenever the top-level field doesn't show up.
        if (item.asleep != null && item.asleep > 0) {
          d.sleep_total_hrs = round2(item.asleep);
        } else if (item.deep != null || item.rem != null || item.core != null) {
          d.sleep_total_hrs = round2((item.deep || 0) + (item.rem || 0) + (item.core || 0));
        }
        // Times
        if (item.sleepStart) d.sleep_start = item.sleepStart;
        if (item.sleepEnd)   d.sleep_end   = item.sleepEnd;
      }

      // ── Resting Heart Rate ──────────────────────────────
      // Name: "Resting Heart Rate", fields: qty (bpm)
      if (metricName.includes('resting_heart_rate')) {
        if (item.qty != null) d.resting_hr = round1(item.qty);
      }

      // ── HRV (Heart Rate Variability SDNN) ───────────────
      // Name: "Heart Rate Variability", fields: qty or Avg (ms)
      if (metricName.includes('heart_rate_variability')) {
        const val = item.Avg ?? item.avg ?? item.qty;
        if (val != null) d.hrv_ms = round2(val);
      }

      // ── Step Count ──────────────────────────────────────
      // Name: "Step Count", fields: qty (count)
      if (metricName === 'step_count' || metricName === 'steps') {
        const steps = parseInt(item.qty);
        if (!isNaN(steps)) {
          d.steps = (d.steps || 0) + steps;
          const t = new Date(rawDate).getTime();
          if (Number.isFinite(t)) activitySamples.steps.push({ t, qty: steps });
        }
      }

      // ── Walking + Running Distance ───────────────────────
      // Name: "Walking + Running Distance", fields: qty (km)
      // Same per-window sample pattern as Step Count — sums across all
      // samples for the date rather than taking the last one seen.
      if (metricName.includes('walking_running_distance')) {
        const val = item.qty;
        if (val != null) d.distance_km = round2((d.distance_km || 0) + Number(val));
      }

      // ── Energy unit converter ─────────────────────────────
      // Health Auto Export can send energy in kcal, kJ, or MJ depending on
      // the device locale and app settings. Convert all to kcal.
      // Note: deliberately NOT rounded here — rounding is applied once,
      // after summation, in the accumulator lines below. Rounding every
      // individual sample before summing thousands of them would compound
      // rounding error into a meaningfully wrong daily total.
      const toKcal = (val, units) => {
        if (units.includes('mj'))              return val * 238.846; // megajoules
        if (units.includes('kj'))              return val / 4.184;   // kilojoules
        if (units.includes('cal') && !units.includes('kcal')) return val / 1000; // cal → kcal
        return val; // already kcal
      };

      // ── Active Energy Burned ─────────────────────────────
      // Health Auto Export sends one sample per minute of Apple Watch
      // activity (commonly several thousand samples/day). Sum across all
      // samples for the date, same pattern as Step Count above.
      if (metricName.includes('active_energy')) {
        const val = item.qty;
        if (val != null) d.active_energy_kcal = (d.active_energy_kcal || 0) + toKcal(val, metricUnits);
      }

      // ── Resting Energy (Basal Metabolic Rate lived) ───────
      // Same per-minute sample pattern as Active Energy above.
      if (metricName.includes('resting_energy') || metricName === 'basal_energy_burned') {
        const val = item.qty ?? item.Avg ?? item.avg;
        if (val != null) d.resting_energy_kcal = (d.resting_energy_kcal || 0) + toKcal(val, metricUnits);
      }

      // ── Dietary Energy ───────────────────────────────────
      // Health Auto Export sends one sample per logged meal/entry (e.g. one
      // per MyFitnessPal food log), not a daily total. Sum across all
      // entries for the date to get the true daily intake.
      //
      // Known to run high vs MFP's own diary total when MFP leaves a stale
      // duplicate HealthKit sample behind after an edited entry — nothing
      // dedupes those here. The dashboard now prefers daily_logs.cal_mfp
      // (scraped directly from MFP's diary, see mfp-import.js) over this
      // field for that reason; this stays as the fallback for days with no
      // MFP sync.
      if (metricName.includes('dietary_energy')) {
        const val = item.qty ?? item.Avg ?? item.avg;
        if (val != null) d.dietary_energy_kcal = (d.dietary_energy_kcal || 0) + toKcal(val, metricUnits);
      }

      // ── Body Weight ─────────────────────────────────────
      // Name: "Body Weight" or "Weight", units: kg or lb
      // Skipped entirely for a manual-weight-logging user — see ignoreWeight above.
      if (metricName.includes('weight') && !ignoreWeight) { // matches weight_body_mass, body_weight, weight
        const val = item.qty;
        if (val != null) {
          const kg = metricUnits.includes('lb') ? round2(val * 0.453592) : round2(val);
          d.weight_kg = kg;
        }
      }

      // ── Body Fat Percentage ─────────────────────────────
      if (metricName.includes('body_fat')) {
        if (item.qty != null) d.body_fat_pct = round2(item.qty);
      }

      // ── Body Mass Index ─────────────────────────────────
      if (metricName.includes('body_mass_index') || metricName === 'bmi') {
        if (item.qty != null) d.bmi = round2(item.qty);
      }

      // ── Blood Glucose ────────────────────────────────────
      // Name: "Blood Glucose", fields: qty (mmol/L or mg/dL)
      if (metricName.includes('blood_glucose')) {
        const val = item.qty;
        if (val != null) {
          const mmol = metricUnits.includes('mg') ? round2(val / 18.0182) : round2(val);
          if (!d._glucose) d._glucose = [];
          d._glucose.push(mmol);
        }
      }

      // ── Blood Oxygen (SpO2) ─────────────────────────────
      // Name: "Blood Oxygen Saturation" or "Oxygen Saturation"
      if (metricName.includes('oxygen_saturation') || metricName.includes('blood_oxygen')) {
        const val = item.qty ?? item.Avg ?? item.avg;
        const minVal = item.Min ?? item.min;
        if (val != null) {
          if (!d._spo2) d._spo2 = [];
          d._spo2.push(Number(val));
        }
        if (minVal != null) {
          d.spo2_min = Math.min(d.spo2_min ?? 100, Number(minVal));
        }
      }

      // ── Respiratory Rate ─────────────────────────────────
      // Name: "Respiratory Rate", fields: qty or Avg (breaths/min)
      if (metricName.includes('respiratory_rate')) {
        const val = item.Avg ?? item.avg ?? item.qty;
        if (val != null) d.respiratory_rate = round1(val);
      }

      // ── Wrist Temperature (deviation from baseline) ──────
      // Name: "Apple Sleeping Wrist Temperature", fields: qty (°C deviation)
      if (metricName.includes('wrist_temperature') || metricName.includes('sleeping_wrist')) {
        const val = item.qty;
        if (val != null) d.wrist_temp_dev = round2(val);
      }

      // ── VO2 Max ──────────────────────────────────────────
      // Name: "VO2 Max", fields: qty (mL/kg/min)
      if (metricName.includes('vo2_max') || metricName === 'vo2max') {
        const val = item.qty;
        if (val != null) d.vo2_max = round1(val);
      }

      // ── Exercise Minutes ─────────────────────────────────
      // Name: "Apple Exercise Time" or "Exercise Time"
      // Sums across all samples for the date, same pattern as Step Count —
      // this metric arrives as multiple per-window samples throughout the
      // day via the automated sync, not one daily total.
      if (metricName.includes('exercise_time') || metricName.includes('exercise_minutes')) {
        const val = item.qty;
        if (val != null) d.exercise_mins = Math.round((d.exercise_mins || 0) + Number(val));
      }

      // ── Heart Rate (workout average + whole-day average) ──
      // Name: "Heart Rate". The automated sync sends many per-window
      // samples across the day, each with its own Avg — not one daily
      // summary — so a whole-day average must be aggregated from all
      // samples' Avg values rather than overwritten by the last one seen.
      if (metricName === 'heart_rate') {
        const val = item.Avg ?? item.avg;
        if (val != null) {
          d.workout_hr_avg = round1(val);
          if (!d._hrSamples) d._hrSamples = [];
          d._hrSamples.push(Number(val));
          const t = new Date(rawDate).getTime();
          if (Number.isFinite(t)) activitySamples.hr.push({ t, val: Number(val) });
        }
      }
    }
  }

  // ── Undetected-activity detection ──────────────────────────
  // Flags a burst of elevated heart rate + dense steps that never
  // showed up as a real Apple Health Workout — HealthKit doesn't
  // auto-detect e.g. pushing a stroller the way it does a run or ride.
  // Never auto-logged: a match becomes a pending row the user confirms
  // or dismisses from an in-app popup, surfaced via a push notification.
  let detectedCount = 0;
  if (activitySamples.steps.length) {
    try {
      const restingHrFallback = Object.values(byDate).map(d => d.resting_hr).find(v => v != null)
        ?? await fetchRecentRestingHr(user_id);
      const weightKgFallback = Object.values(byDate).map(d => d.weight_kg).find(v => v != null)
        ?? await fetchRecentWeightKg(user_id);
      const windows = detectUndetectedActivity(activitySamples.steps, activitySamples.hr, restingHrFallback);

      if (windows.length) {
        const minMs = Math.min(...windows.map(w => w.startMs));
        const maxMs = Math.max(...windows.map(w => w.endMs));
        const padMs = 3 * 3600000; // wide enough that a workout logged just before/after a window still counts as "already covered"
        const [existingWorkoutsRes, existingDetectedRes] = await Promise.all([
          sbFetch(`/rest/v1/apple_health_workouts?user_id=eq.${user_id}&started_at=lte.${new Date(maxMs + padMs).toISOString()}&ended_at=gte.${new Date(minMs - padMs).toISOString()}&select=started_at,ended_at`),
          sbFetch(`/rest/v1/detected_activities?user_id=eq.${user_id}&started_at=gte.${new Date(minMs - padMs).toISOString()}&started_at=lte.${new Date(maxMs + padMs).toISOString()}&select=started_at`),
        ]);
        const existingWorkouts = existingWorkoutsRes.ok ? (existingWorkoutsRes.data || []) : [];
        const existingDetected = existingDetectedRes.ok ? (existingDetectedRes.data || []) : [];

        // 30min tolerance on detected_activities — Health Auto Export
        // resends a rolling window of recent days on every sync, so
        // without this the same walk would re-flag (and re-notify) on
        // every subsequent sync until the user confirms/dismisses it.
        const DEDUP_TOLERANCE_MS = 30 * 60000;
        const overlapsRealWorkout = w => existingWorkouts.some(rw => {
          const rs = new Date(rw.started_at).getTime(), re = new Date(rw.ended_at).getTime();
          return w.startMs < re && w.endMs > rs;
        });
        const isDuplicateDetection = w => existingDetected.some(ed =>
          Math.abs(new Date(ed.started_at).getTime() - w.startMs) < DEDUP_TOLERANCE_MS
        );

        const newlyDetected = [];
        for (const w of windows) {
          if (newlyDetected.length >= 3) break; // safety cap — one sync call shouldn't ever flood the queue
          if (overlapsRealWorkout(w) || isDuplicateDetection(w)) continue;
          const insertRes = await sbFetch('/rest/v1/detected_activities', 'POST', {
            user_id,
            started_at: new Date(w.startMs).toISOString(),
            ended_at: new Date(w.endMs).toISOString(),
            duration_min: w.durationMin,
            avg_heart_rate: w.avgHeartRate,
            max_heart_rate: w.maxHeartRate,
            steps: w.steps,
            active_energy_kcal: stepsToCalories(w.steps, weightKgFallback),
          }, { 'Prefer': 'return=minimal' });
          if (insertRes.ok) { newlyDetected.push(w); detectedCount++; }
        }

        if (newlyDetected.length) await notifyDetectedActivities(user_id, newlyDetected);
      }
    } catch (err) {
      console.error('Activity detection error:', err.message);
    }
  }

  // ── 4. Upsert each date row ───────────────────────────────
  const processed = [];
  const errors    = [];

  for (const [logDate, d] of Object.entries(byDate)) {
    // Round energy totals once, after full-precision summation
    if (d.active_energy_kcal  != null) d.active_energy_kcal  = round1(d.active_energy_kcal);
    if (d.resting_energy_kcal != null) d.resting_energy_kcal = round1(d.resting_energy_kcal);
    if (d.dietary_energy_kcal != null) d.dietary_energy_kcal = round1(d.dietary_energy_kcal);

    // Aggregate glucose
    if (d._glucose?.length) {
      d.glucose_avg_mmol = round2(d._glucose.reduce((a,b) => a+b, 0) / d._glucose.length);
      d.glucose_min_mmol = round2(Math.min(...d._glucose));
      d.glucose_max_mmol = round2(Math.max(...d._glucose));
      delete d._glucose;
    }

    // Aggregate SpO2
    if (d._spo2?.length) {
      d.spo2_avg = round1(d._spo2.reduce((a,b) => a+b, 0) / d._spo2.length);
      if (!d.spo2_min) d.spo2_min = round1(Math.min(...d._spo2));
      delete d._spo2;
    }

    // Aggregate whole-day average heart rate
    if (d._hrSamples?.length) {
      d.heart_rate_avg = round1(d._hrSamples.reduce((a,b) => a+b, 0) / d._hrSamples.length);
      delete d._hrSamples;
    }

    const row = {
      user_id,
      log_date: logDate,
      ...d,
      readiness_score: computeReadiness(d),
      synced_at: new Date().toISOString(), // always update so dashboard shows correct last-sync time
    };

    const res = await sbFetch(
      '/rest/v1/health_daily?on_conflict=user_id,log_date',
      'POST',
      row,
      { 'Prefer': 'resolution=merge-duplicates,return=minimal' }
    );

    if (res.ok) {
      processed.push(logDate);

      // ── Back-fill into daily_logs ─────────────────────
      const logUpdate = { user_id, log_date: logDate };
      let hasUpdate = false;

      if (row.steps != null) {
        logUpdate.steps = row.steps;
        hasUpdate = true;
      }

      if (row.weight_kg != null) {
        logUpdate.weight = row.weight_kg;
        hasUpdate = true;
      }

      // Fix: use != null not falsy check — 0 kcal is valid
      if (row.dietary_energy_kcal != null) {
        logUpdate.cal_apple = row.dietary_energy_kcal;
        hasUpdate = true;
      }

      if (hasUpdate) {
        sbFetch(
          '/rest/v1/daily_logs?on_conflict=user_id,log_date',
          'POST',
          logUpdate,
          { 'Prefer': 'resolution=merge-duplicates,return=minimal' }
        );
      }
    } else {
      errors.push({ date: logDate, error: res.error });
      console.error('Upsert error for', logDate, res.error);
    }
  }

  // Collect unit info for debugging
  const unitsSeen = {};
  for (const metric of metrics) {
    const name  = (metric.name  || '').toLowerCase().replace(/\s+/g, '_');
    const units = (metric.units || '').toLowerCase();
    if (name.includes('energy')) unitsSeen[name] = units;
  }

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      received:  Object.keys(byDate).length,
      processed: processed.length,
      workoutsReceived: workouts.length,
      workoutsProcessed,
      detectedCount,
      errors:    errors.length,
      dates:     processed,
      unitsSeen, // shows what unit strings Health Auto Export sent
      ...(errors.length ? { errorDetails: errors } : {}),
    }),
  };
};

// ── Readiness score (0–100) ───────────────────────────────
function computeReadiness(d) {
  let score = 100, factors = 0;
  if (d.sleep_total_hrs != null) {
    const s = d.sleep_total_hrs;
    const ss = s >= 7 && s <= 9 ? 100 : s >= 6 ? 75 : s >= 5 ? 50 : s > 9 ? 85 : 25;
    score = score * 0.6 + ss * 0.4; factors++;
  }
  if (d.hrv_ms != null) {
    const h = d.hrv_ms;
    const hs = h >= 80 ? 100 : h >= 60 ? 85 : h >= 40 ? 70 : h >= 20 ? 50 : 30;
    score = score * 0.7 + hs * 0.3; factors++;
  }
  if (d.resting_hr != null) {
    const r = d.resting_hr;
    const rs = r < 55 ? 100 : r < 65 ? 85 : r < 75 ? 70 : r < 85 ? 50 : 30;
    score = score * 0.8 + rs * 0.2; factors++;
  }
  return factors > 0 ? Math.round(Math.max(0, Math.min(100, score))) : null;
}

async function fetchRecentRestingHr(user_id) {
  const res = await sbFetch(`/rest/v1/health_daily?user_id=eq.${user_id}&resting_hr=not.is.null&select=resting_hr&order=log_date.desc&limit=1`);
  return res.ok && res.data?.[0]?.resting_hr != null ? Number(res.data[0].resting_hr) : null;
}

async function fetchRecentWeightKg(user_id) {
  const res = await sbFetch(`/rest/v1/health_daily?user_id=eq.${user_id}&weight_kg=not.is.null&select=weight_kg&order=log_date.desc&limit=1`);
  return res.ok && res.data?.[0]?.weight_kg != null ? Number(res.data[0].weight_kg) : null;
}

// ── Undetected-activity heuristic ──────────────────────────
// Bins step + heart-rate samples into fixed-width buckets (by absolute
// time, not calendar day — see activitySamples in the handler above)
// and looks for a contiguous run where BOTH heart rate is meaningfully
// above resting AND steps are dense enough to be real ambulatory
// movement. Either signal alone is too noisy on its own (HR alone:
// caffeine/stress/heat; steps alone: phone-in-pocket miscounts while
// doing chores) but together they're a reasonable proxy for "this was
// actually a walk" — e.g. pushing a stroller, which HealthKit's own
// workout auto-detection doesn't cover the way it does a run or ride.
const ACTIVITY_BIN_MIN                     = 10;   // minutes per bin
const ACTIVITY_HR_ABOVE_REST               = 25;   // bpm above resting HR to count as "elevated"
const ACTIVITY_HR_FALLBACK                 = 100;  // used only when resting HR is unknown
const ACTIVITY_STEPS_PER_BIN               = 250;  // steps needed in a bin to count as "dense" walking, when HR corroborates it
const ACTIVITY_STEPS_ONLY_PER_BIN          = 450;  // no HR sample to rule out phone-in-pocket miscounts during chores, so demand much denser steps
const ACTIVITY_MIN_DURATION_MIN            = 15;   // shortest window worth flagging
const ACTIVITY_STEPS_ONLY_MIN_DURATION_MIN = 25;   // and a longer sustained run, for the same reason
const ACTIVITY_MAX_GAP_BINS                = 1;    // bridges one quiet bin inside an otherwise-elevated run (e.g. stopped at a crossing)
const STEP_KCAL_PER_KG                     = 0.0005; // ≈0.04 kcal/step for an 80kg adult — standard steps × weight walking-calorie approximation, used since stride length isn't measured

function stepsToCalories(steps, weightKg) {
  if (!steps || !weightKg) return null;
  return Math.round(steps * weightKg * STEP_KCAL_PER_KG);
}

// hrSamples can legitimately be empty — a Watch's heart-rate samples
// sometimes land in Health a beat behind step counts, so a sync can see
// dense steps with zero HR samples yet. Rather than skip detection for
// that whole sync (losing the walk for good, since raw samples aren't
// persisted), fall back to a steps-only read with a stricter bar.
function detectUndetectedActivity(stepSamples, hrSamples, restingHr) {
  const binMs = ACTIVITY_BIN_MIN * 60000;
  const binOf = t => Math.floor(t / binMs);
  const bins = new Map(); // binIndex -> { steps, hrSum, hrCount, maxHr }
  function getBin(idx) {
    if (!bins.has(idx)) bins.set(idx, { steps: 0, hrSum: 0, hrCount: 0, maxHr: 0 });
    return bins.get(idx);
  }
  for (const s of stepSamples) getBin(binOf(s.t)).steps += s.qty;
  for (const s of hrSamples) {
    const b = getBin(binOf(s.t));
    b.hrSum += s.val; b.hrCount++; b.maxHr = Math.max(b.maxHr, s.val);
  }

  const hasHr = hrSamples.length >= 3;
  const stepsThreshold = hasHr ? ACTIVITY_STEPS_PER_BIN : ACTIVITY_STEPS_ONLY_PER_BIN;
  const minDurationMin = hasHr ? ACTIVITY_MIN_DURATION_MIN : ACTIVITY_STEPS_ONLY_MIN_DURATION_MIN;
  const hrThreshold = restingHr ? restingHr + ACTIVITY_HR_ABOVE_REST : ACTIVITY_HR_FALLBACK;
  const sortedIdx = [...bins.keys()].sort((a, b) => a - b);
  const elevated = new Set();
  for (const idx of sortedIdx) {
    const b = bins.get(idx);
    if (b.steps < stepsThreshold) continue;
    if (hasHr) {
      const avgHr = b.hrCount ? b.hrSum / b.hrCount : null;
      if (avgHr == null || avgHr < hrThreshold) continue;
    }
    elevated.add(idx);
  }

  const windows = [];
  const visited = new Set();
  for (const idx of sortedIdx) {
    if (!elevated.has(idx) || visited.has(idx)) continue;
    let start = idx, end = idx, gap = 0;
    visited.add(idx);
    while (true) {
      const next = end + 1;
      if (elevated.has(next)) { end = next; visited.add(next); gap = 0; }
      // Bridges a non-elevated (or entirely sample-free — a real watch
      // frequently has a gap of no readings at all for a stretch) bin,
      // up to the gap tolerance — not gated on bins.has(next), since a
      // missing bin is exactly the kind of gap this should bridge too.
      else if (gap < ACTIVITY_MAX_GAP_BINS) { end = next; gap++; visited.add(next); }
      else break;
    }
    while (end > start && !elevated.has(end)) end--; // trim a bridged-but-unconfirmed trailing gap
    const durationMin = (end - start + 1) * ACTIVITY_BIN_MIN;
    if (durationMin >= ACTIVITY_MIN_DURATION_MIN) {
      let steps = 0, hrSum = 0, hrCount = 0, maxHr = 0;
      for (let b = start; b <= end; b++) {
        const bin = bins.get(b);
        if (!bin) continue;
        steps += bin.steps;
        if (bin.hrCount) { hrSum += bin.hrSum; hrCount += bin.hrCount; }
        maxHr = Math.max(maxHr, bin.maxHr);
      }
      windows.push({
        startMs: start * binMs,
        endMs: (end + 1) * binMs,
        durationMin,
        steps: Math.round(steps),
        avgHeartRate: hrCount ? Math.round((hrSum / hrCount) * 10) / 10 : null,
        maxHeartRate: maxHr || null,
      });
    }
  }
  return windows;
}

async function notifyDetectedActivities(user_id, windows) {
  const subsRes = await sbFetch(`/rest/v1/push_subscriptions?user_id=eq.${user_id}&select=endpoint,p256dh,auth_key`);
  const subs = subsRes.ok ? (subsRes.data || []) : [];
  if (!subs.length) return;
  const w = windows[0]; // one notification even if a couple were detected in the same sync call
  const when = new Date(w.startMs).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
  const more = windows.length > 1 ? ` (+${windows.length - 1} more)` : '';
  const payload = {
    title: 'Possible activity detected 🚶',
    body: `Looks like a ~${w.durationMin}-min walk around ${when}${more} — open fitl00p to confirm or ignore.`,
    url: '/', tag: 'detected-activity',
  };
  for (const s of subs) {
    try { await sendWebPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload); } catch {}
  }
}

// ── Helpers ───────────────────────────────────────────────
const round1 = n => n == null ? null : Math.round(Number(n) * 10)   / 10;
const round2 = n => n == null ? null : Math.round(Number(n) * 100)  / 100;

// Workout fields arrive as { qty, units } rather than the metrics loop's
// separate qty/units pair — same conversions, different shape, so kept as
// their own small helpers rather than reshaping data to fit the other one.
function qtyToKcal(field) {
  if (field?.qty == null) return null;
  const val = Number(field.qty);
  const units = (field.units || '').toLowerCase();
  if (units.includes('mj')) return round1(val * 238.846);
  if (units.includes('kj')) return round1(val / 4.184);
  if (units.includes('cal') && !units.includes('kcal')) return round1(val / 1000);
  return round1(val);
}
function qtyToKm(field) {
  if (field?.qty == null) return null;
  const val = Number(field.qty);
  const units = (field.units || '').toLowerCase();
  return round2(units.includes('mi') ? val * 1.60934 : val);
}

async function sbFetch(path, method = 'GET', body = null, extra = {}) {
  try {
    const res = await fetch(`${SB_URL}${path}`, {
      method,
      headers: {
        'Content-Type':  'application/json',
        'apikey':        SB_SERVICE,
        'Authorization': `Bearer ${SB_SERVICE}`,
        ...extra,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    // 204 = success with no content (upsert with return=minimal)
    if (res.status === 204) return { ok: true, status: 204, data: null, error: null };
    const data  = res.ok  ? await res.json().catch(() => null) : null;
    const error = !res.ok ? await res.text().catch(() => '')   : null;
    return { ok: res.ok, status: res.status, data, error };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err.message };
  }
}

// Pure helpers exported alongside the handler so they can be unit-tested
// directly rather than only indirectly through a full simulated sync payload.
exports.detectUndetectedActivity = detectUndetectedActivity;
exports.stepsToCalories = stepsToCalories;
