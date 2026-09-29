// Scheduled: every 15 min (pg_cron → private.invoke_edge_fn('hevy-sync')).
// Pulls workouts changed in Hevy since the last run via the public API's
// /v1/workouts/events feed and upserts a one-row summary per workout into
// hevy_workouts (deletes too). Summary only — duration, exercise/set
// counts, volume — for the workout history list; Hevy keeps set detail.
//
// Single linked account for now: the Hevy Pro API key belongs to Lewis —
// user id hardcoded like GEMMA_USER_ID in _shared/webpush.ts, overridable
// with HEVY_USER_ID. The key lives in Supabase Vault ('hevy_api_key'),
// read through the service-role-only RPC get_hevy_api_key(); a
// HEVY_API_KEY function secret takes precedence if ever set. The cursor
// lives in hevy_sync_state; with no row yet the first run backfills the
// whole Hevy history.

const SB_URL       = Deno.env.get('SUPABASE_URL');
const SB_SERVICE   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
let   HEVY_API_KEY = Deno.env.get('HEVY_API_KEY');
const HEVY_USER_ID = Deno.env.get('HEVY_USER_ID') || 'cae63d3e-df60-4415-8a43-64748b6591c3';

const HEVY_BASE = 'https://api.hevyapp.com/v1';

async function sb(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SB_URL}${path}`, {
    ...init,
    headers: {
      apikey: SB_SERVICE!, Authorization: `Bearer ${SB_SERVICE}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${init.method || 'GET'} ${path.split('?')[0]} → ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function hevy(route: string) {
  const res = await fetch(HEVY_BASE + route, { headers: { 'api-key': HEVY_API_KEY! } });
  if (!res.ok) throw new Error(`Hevy GET ${route.split('?')[0]} → ${res.status}: ${await res.text()}`);
  return res.json();
}

function summarise(w: any, userId: string) {
  let setCount = 0, volume = 0;
  const exercises = (w.exercises || []).map((ex: any) => {
    const working = (ex.sets || []).filter((s: any) => s.type !== 'warmup');
    setCount += working.length;
    for (const s of working) {
      if (s.weight_kg > 0 && s.reps > 0) volume += s.weight_kg * s.reps;
    }
    return { title: ex.title, sets: working.length };
  });
  const start = new Date(w.start_time), end = w.end_time ? new Date(w.end_time) : null;
  return {
    id: w.id,
    user_id: userId,
    title: w.title || null,
    routine_id: w.routine_id || null,
    started_at: w.start_time,
    ended_at: w.end_time || null,
    duration_min: end ? Math.round((end.getTime() - start.getTime()) / 60000) : null,
    exercise_count: exercises.length,
    set_count: setCount,
    volume_kg: Math.round(volume),
    exercises,
    hevy_updated_at: w.updated_at || null,
    synced_at: new Date().toISOString(),
  };
}

Deno.serve(async () => {
  if (!SB_URL || !SB_SERVICE) return new Response('Supabase env vars missing', { status: 500 });
  if (!HEVY_API_KEY) {
    HEVY_API_KEY = await sb('/rest/v1/rpc/get_hevy_api_key', { method: 'POST', body: '{}' }).catch(() => null) || undefined;
  }
  if (!HEVY_API_KEY || !HEVY_USER_ID) return new Response('Hevy not configured — skipping');

  const runStartedAt = new Date().toISOString();
  try {
    const state = await sb(`/rest/v1/hevy_sync_state?user_id=eq.${HEVY_USER_ID}&select=last_synced_at`);
    const since = state?.[0]?.last_synced_at || '1970-01-01T00:00:00Z';

    const upserts: any[] = [];
    const deletes: string[] = [];
    let page = 1, pageCount = 1;
    do {
      const r = await hevy(`/workouts/events?page=${page}&pageSize=10&since=${encodeURIComponent(since)}`);
      for (const e of r.events || []) {
        if (e.type === 'updated' && e.workout) upserts.push(summarise(e.workout, HEVY_USER_ID));
        else if (e.type === 'deleted' && e.id) deletes.push(e.id);
      }
      pageCount = r.page_count || 1;
      page++;
    } while (page <= pageCount);

    if (upserts.length) {
      await sb('/rest/v1/hevy_workouts?on_conflict=id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(upserts),
      });
    }
    if (deletes.length) {
      await sb(`/rest/v1/hevy_workouts?id=in.(${deletes.map(encodeURIComponent).join(',')})`, {
        method: 'DELETE', headers: { Prefer: 'return=minimal' },
      });
    }
    // Only advance the cursor once everything above landed, so a failed run
    // retries the same window next time instead of skipping it.
    await sb('/rest/v1/hevy_sync_state?on_conflict=user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: HEVY_USER_ID, last_synced_at: runStartedAt }),
    });

    return new Response(JSON.stringify({ upserted: upserts.length, deleted: deletes.length, since }));
  } catch (err) {
    console.error('hevy-sync failed:', (err as Error).message);
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 502 });
  }
});
