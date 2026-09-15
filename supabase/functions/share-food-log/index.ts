// Lets one household member's Log Food entry also get logged straight
// into their partner's food_log — "I cook for both of us, log it once
// for us both." Needs a service-key write: food_log's RLS is strictly
// own-write (auth.uid() = user_id), and there's no policy letting one
// account insert rows for another — loosening that for everyone just to
// cover this one two-person household relationship isn't worth the
// blast radius. Same fixed Lewis<->Gemma pairing already hardcoded
// server-side for the Gemma-specific scheduled notifications (see
// GEMMA_USER_ID in _shared/webpush.ts) — this app only ever has these
// two accounts.
//
// Ported from src/netlify/functions/share-food-log.js — mechanical
// translation to Deno.serve; logic unchanged.

import { GEMMA_USER_ID } from '../_shared/webpush.ts';

const LEWIS_USER_ID = 'cae63d3e-df60-4415-8a43-64748b6591c3';
const HOUSEHOLD_PARTNER: Record<string, string> = {
  [LEWIS_USER_ID]: GEMMA_USER_ID,
  [GEMMA_USER_ID]: LEWIS_USER_ID,
};

const SB_URL     = Deno.env.get('SUPABASE_URL');
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_KEY');

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  // Same-origin browser requests never trigger a CORS preflight, so this
  // was invisible until the native app started calling this cross-origin
  // — without these two, the browser rejects the OPTIONS preflight for
  // the POST's Content-Type/Authorization headers, and the real request
  // never sends.
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: HEADERS });
  }
  if (!SB_URL || !SB_SERVICE) {
    return new Response(JSON.stringify({ error: 'Server not configured' }), { status: 500, headers: HEADERS });
  }

  // ── Authenticate the caller — same Supabase-JWT pattern as the other
  // service-key functions (health-apikey.js, food-photo-estimate.js).
  const authHeader = req.headers.get('authorization') || req.headers.get('Authorization') || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers: HEADERS });
  const userRes = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${jwt}`, apikey: SB_SERVICE },
  });
  if (!userRes.ok) return new Response(JSON.stringify({ error: 'Invalid session' }), { status: 401, headers: HEADERS });
  const caller = await userRes.json();

  const partnerId = HOUSEHOLD_PARTNER[caller.id];
  if (!partnerId) {
    return new Response(JSON.stringify({ error: 'No linked household partner for this account' }), { status: 403, headers: HEADERS });
  }

  let body: any;
  try {
    body = JSON.parse((await req.text()) || '{}');
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON: ' + (e as Error).message }), { status: 400, headers: HEADERS });
  }

  const { log_date, logged_at, meal_slot, food_name, brand, serving_desc, quantity, calories_kcal, protein_g, carbs_g, fat_g, barcode } = body;
  if (!log_date || !meal_slot || !food_name || !(Number(calories_kcal) > 0)) {
    return new Response(JSON.stringify({ error: 'Missing required food fields' }), { status: 400, headers: HEADERS });
  }
  // Same logged time the sharer's own entry got (their photo's EXIF time,
  // or whatever they set/left as "now") — a backfilled meal shared to a
  // partner should land at the same real time in both logs, not whenever
  // this request happened to reach the server.
  const loggedAtParsed = logged_at ? new Date(logged_at) : null;
  const loggedAtIso = loggedAtParsed && !Number.isNaN(loggedAtParsed.getTime()) ? loggedAtParsed.toISOString() : new Date().toISOString();

  const foodLogRow = {
    user_id: partnerId,
    log_date,
    logged_at: loggedAtIso,
    meal_slot,
    source: 'shared',
    food_name: String(food_name).slice(0, 200),
    brand: brand ? String(brand).slice(0, 200) : null,
    serving_desc: serving_desc ? String(serving_desc).slice(0, 200) : null,
    quantity: Number(quantity) || 1,
    calories_kcal: Math.round(Number(calories_kcal)),
    protein_g: Math.round((Number(protein_g) || 0) * 10) / 10,
    carbs_g: Math.round((Number(carbs_g) || 0) * 10) / 10,
    fat_g: Math.round((Number(fat_g) || 0) * 10) / 10,
    barcode: barcode || null,
  };

  const insertRes = await fetch(`${SB_URL}/rest/v1/food_log`, {
    method: 'POST',
    headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(foodLogRow),
  });
  if (!insertRes.ok) {
    const errText = await insertRes.text().catch(() => '');
    return new Response(JSON.stringify({ error: `Couldn't save to partner's log: ${errText.slice(0, 300)}` }), { status: 502, headers: HEADERS });
  }
  const insertedFoodLog = await insertRes.json().catch(() => []);
  const partnerFoodLogId = insertedFoodLog?.[0]?.id || null;

  // Bridge into the partner's own diabetes tracking too, when relevant —
  // same shape the app's own Log Food save already inserts for whoever's
  // logging, so a shared meal keeps dose-learning working for a
  // diabetes-enabled partner exactly like a self-logged one does.
  try {
    const profRes = await fetch(`${SB_URL}/rest/v1/profiles?id=eq.${partnerId}&select=diabetes_enabled`, {
      headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` },
    });
    const profData = profRes.ok ? await profRes.json() : [];
    const partnerDiabetesOn = profData?.[0]?.diabetes_enabled !== false;
    if (partnerDiabetesOn && foodLogRow.carbs_g > 0) {
      await fetch(`${SB_URL}/rest/v1/diabetes_meals`, {
        method: 'POST',
        headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({
          user_id: partnerId,
          food_log_id: partnerFoodLogId,
          eaten_at: foodLogRow.logged_at,
          meal_name: foodLogRow.food_name,
          carbs_g: foodLogRow.carbs_g,
          fat_g: foodLogRow.fat_g,
          protein_g: foodLogRow.protein_g,
          source: 'manual',
        }),
      });
    }
  } catch {
    // Non-fatal — the partner's food_log row already saved; the
    // diabetes bridge is a nice-to-have on top of that, not required.
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: HEADERS });
});
