// Receives daily Health metrics uploaded by the native iOS background
// delivery code (HealthBackgroundSync.swift) while the app's web view —
// and with it the user's Supabase login session — isn't running.
//
// Auth: the native side can't safely share or refresh the web app's
// session (refresh-token rotation would log the web view out), so it
// holds a separate random per-user ingest token instead. Only the SHA-256
// hash lives in public.health_ingest_tokens (written by the signed-in
// app under RLS); the raw token is checked here against that hash. The
// request itself still carries the anon key as Bearer so the platform's
// verify_jwt gate passes.
//
// Writes use the service key (needed since there's no user JWT), but only
// to health_daily rows for the token's own user, and only for whitelisted
// metric columns.

const SB_URL     = Deno.env.get('SUPABASE_URL');
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Ingest-Token',
  'Content-Type': 'application/json',
};

const ALLOWED = new Set([
  'steps', 'distance_km', 'active_energy_kcal', 'heart_rate_avg', 'resting_hr',
  'hrv_ms', 'exercise_mins', 'resting_energy_kcal', 'weight_kg',
  'sleep_total_hrs', 'sleep_deep_hrs', 'sleep_rem_hrs', 'sleep_core_hrs',
]);
const ALLOWED_TS = new Set(['sleep_start', 'sleep_end']);
const WORKOUT_NUM = ['duration_min', 'active_energy_kcal', 'distance_km'];
const ISO_TS = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: HEADERS });

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!SB_URL || !SB_SERVICE) return json({ error: 'Server not configured' }, 500);

  const token = req.headers.get('x-ingest-token') || '';
  let body: { userId?: string; rows?: Record<string, unknown>[]; workouts?: Record<string, unknown>[] };
  try { body = await req.json(); } catch { return json({ error: 'Bad JSON' }, 400); }
  const userId = body.userId;
  if (!token || !userId || !/^[0-9a-f-]{36}$/i.test(userId) || !Array.isArray(body.rows)) {
    return json({ error: 'Bad request' }, 400);
  }

  const svc = { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` };
  const tokRes = await fetch(
    `${SB_URL}/rest/v1/health_ingest_tokens?user_id=eq.${userId}&select=token_hash`,
    { headers: svc },
  );
  const tokRows = tokRes.ok ? await tokRes.json() : [];
  if (!tokRows.length || tokRows[0].token_hash !== await sha256Hex(token)) {
    return json({ error: 'Invalid token' }, 401);
  }

  const now = new Date().toISOString();
  const rows = body.rows.slice(0, 14).flatMap(r => {
    const date = String(r.log_date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    const out: Record<string, unknown> = { user_id: userId, log_date: date, synced_at: now };
    for (const [k, v] of Object.entries(r)) {
      if (ALLOWED.has(k) && typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      else if (ALLOWED_TS.has(k) && typeof v === 'string' && ISO_TS.test(v)) out[k] = v;
    }
    return [out];
  });

  const workouts = (Array.isArray(body.workouts) ? body.workouts : []).slice(0, 50).flatMap(w => {
    const ext = String(w.external_id ?? '');
    if (!ext || ext.length > 100 || !ISO_TS.test(String(w.started_at)) || !ISO_TS.test(String(w.ended_at))) return [];
    const out: Record<string, unknown> = {
      user_id: userId, external_id: ext, workout_type: String(w.workout_type ?? 'other').slice(0, 50),
      started_at: w.started_at, ended_at: w.ended_at, synced_at: now,
    };
    for (const k of WORKOUT_NUM) { const v = w[k]; if (typeof v === 'number' && Number.isFinite(v)) out[k] = v; }
    return [out];
  });
  if (!rows.length && !workouts.length) return json({ upserted: 0 });

  // One request per row, not a bulk array: PostgREST fills a key that's
  // missing from some rows of a bulk upsert with NULL, which would wipe
  // an existing metric on merge — per-row payloads only touch their own keys.
  for (const row of rows) {
    const up = await fetch(`${SB_URL}/rest/v1/health_daily?on_conflict=user_id,log_date`, {
      method: 'POST',
      headers: { ...svc, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(row),
    });
    if (!up.ok) return json({ error: 'Upsert failed', detail: (await up.text()).slice(0, 300) }, 500);
  }
  for (const w of workouts) {
    const up = await fetch(`${SB_URL}/rest/v1/apple_health_workouts?on_conflict=user_id,external_id`, {
      method: 'POST',
      headers: { ...svc, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(w),
    });
    if (!up.ok) return json({ error: 'Workout upsert failed', detail: (await up.text()).slice(0, 300) }, 500);
  }
  return json({ upserted: rows.length, workouts: workouts.length });
});
