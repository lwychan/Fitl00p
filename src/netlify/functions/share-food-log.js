// netlify/functions/share-food-log.js
// Lets one household member's Log Food entry also get logged straight
// into their partner's food_log — "I cook for both of us, log it once
// for us both." Needs a service-key write: food_log's RLS is strictly
// own-write (auth.uid() = user_id), and there's no policy letting one
// account insert rows for another — loosening that for everyone just to
// cover this one two-person household relationship isn't worth the
// blast radius. Same fixed Lewis<->Gemma pairing already hardcoded
// server-side for the Gemma-specific scheduled notifications (see
// GEMMA_USER_ID in _lib/webpush.js) — this app only ever has these two
// accounts.

const { GEMMA_USER_ID } = require('./_lib/webpush');

const LEWIS_USER_ID = 'cae63d3e-df60-4415-8a43-64748b6591c3';
const HOUSEHOLD_PARTNER = {
  [LEWIS_USER_ID]: GEMMA_USER_ID,
  [GEMMA_USER_ID]: LEWIS_USER_ID,
};

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
  if (!SB_URL || !SB_SERVICE) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Server not configured' }) };
  }

  // ── Authenticate the caller — same Supabase-JWT pattern as the other
  // service-key functions (health-apikey.js, food-photo-estimate.js).
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Not authenticated' }) };
  const userRes = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${jwt}`, apikey: SB_SERVICE },
  });
  if (!userRes.ok) return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Invalid session' }) };
  const caller = await userRes.json();

  const partnerId = HOUSEHOLD_PARTNER[caller.id];
  if (!partnerId) {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'No linked household partner for this account' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON: ' + e.message }) };
  }

  const { log_date, logged_at, meal_slot, food_name, brand, serving_desc, quantity, calories_kcal, protein_g, carbs_g, fat_g, barcode } = body;
  if (!log_date || !meal_slot || !food_name || !(Number(calories_kcal) > 0)) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing required food fields' }) };
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
    headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(foodLogRow),
  });
  if (!insertRes.ok) {
    const errText = await insertRes.text().catch(() => '');
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: `Couldn't save to partner's log: ${errText.slice(0, 300)}` }) };
  }

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

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true }) };
};
