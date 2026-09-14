// netlify/functions/food-text-estimate.js
// Called from Log Food's "Describe" mode — turns a plain-English meal
// description ("2 baking sweet potatoes and ready cooked chicken
// skewers") into one or more itemised calorie/macro estimates.
//
// The sibling of food-photo-estimate.js, and deliberately shaped
// differently in one way: this returns an ARRAY of items, not a single
// blob. A described meal is usually several distinct foods, and the app
// stores one food_log row per food — collapsing them into a single
// "estimated meal" row would lose the per-item numbers that make an
// estimate correctable, and would mis-shape Snacks (which are dosed
// individually, one diabetes_meals row each, not aggregated).
//
// Sonnet rather than the photo path's Haiku: the hard part here is
// portion inference and splitting a run-on sentence into the right
// items ("chicken and chips" is two foods, "chicken chow mein" is one),
// which is reasoning rather than perception. Text requests are a few
// hundred tokens, so the better model costs little on this path.

const SB_URL     = process.env.SUPABASE_URL;
const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = 'claude-sonnet-5';

const MAX_ITEMS = 12;

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'POST only' }) };
  }
  if (!ANTHROPIC_API_KEY) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured on the server' }) };
  }
  if (!SB_URL || !SB_SERVICE) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Server not configured' }) };
  }

  // Same Supabase-JWT gate as food-photo-estimate.js — this calls a paid
  // API per request, so it isn't left open like the read-only proxies.
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Not authenticated' }) };
  const userRes = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${jwt}`, 'apikey': SB_SERVICE },
  });
  if (!userRes.ok) return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Invalid session' }) };

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON: ' + e.message }) };
  }

  const text = String(body.text || '').trim();
  if (!text) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'text is required' }) };
  if (text.length > 1000) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Description too long — keep it under 1000 characters' }) };

  const prompt = `You are estimating calories and macronutrients for a food diary, from a plain-English description of what someone ate.

What they ate: ${JSON.stringify(text)}

Split this into SEPARATE items, one per distinct food or drink. Rules for splitting:
- "chicken and chips" is TWO items. "chicken chow mein" is ONE item (it's a single named dish).
- A composed dish someone would buy or cook as one thing (lasagne, chicken tikka masala, a BLT) stays as ONE item — do not break it into ingredients.
- A plate of separate components (meat, a starch, a vegetable side) is one item per component.
- If they name a brand or a shop ("Aldi hot honey", "Greggs sausage roll"), keep that in the item name and use that product's real nutrition where you know it.

For EACH item give:
- "food_name": what it is, cleaned up for a diary (e.g. "Baking sweet potato", not "2 baking sweet potatoes")
- "serving_desc": the portion this estimate is for, INCLUDING the count/weight they said (e.g. "2 medium (260g)", "100g", "1 roll")
- calories and macros FOR THE WHOLE AMOUNT THEY SAID — if they ate 2 of something, the numbers cover both, and "quantity" stays 1. Do not return per-unit numbers.

Be decisive: one best number per item, never a range. Where a quantity isn't given, assume a normal adult portion and say so in "note". Never refuse to estimate.

Respond with ONLY a single JSON object, no markdown fences, no other text, in exactly this shape:
{"items": [{"food_name": "<string>", "serving_desc": "<string>", "calories_kcal": <number>, "protein_g": <number>, "carbs_g": <number>, "fat_g": <number>}], "confidence": "low"|"medium"|"high", "note": "<one short sentence — the key portion assumptions you made>"}`;

  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (err) {
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: 'Could not reach Claude: ' + err.message }) };
  }

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text().catch(() => '');
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: `Claude API error (${anthropicRes.status}): ${errText.slice(0, 300)}` }) };
  }

  const data = await anthropicRes.json();
  const rawText = (data?.content || []).map(c => c.text || '').join('').trim();

  const estimate = parseEstimateJson(rawText);
  if (!estimate) {
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: "Couldn't parse an estimate from Claude's response", raw: rawText.slice(0, 300) }) };
  }

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(estimate) };
};

// Claude is asked for bare JSON but occasionally still wraps it in a
// ```json fence anyway — strip that before parsing rather than failing.
function parseEstimateJson(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.items)) return null;

  const num = v => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);
  const items = parsed.items
    .filter(it => it && typeof it.food_name === 'string' && it.food_name.trim() && it.calories_kcal != null)
    .slice(0, MAX_ITEMS)
    .map(it => ({
      food_name: it.food_name.trim().slice(0, 200),
      serving_desc: typeof it.serving_desc === 'string' ? it.serving_desc.trim().slice(0, 100) : '',
      calories_kcal: Math.round(num(it.calories_kcal)),
      protein_g: Math.round(num(it.protein_g) * 10) / 10,
      carbs_g: Math.round(num(it.carbs_g) * 10) / 10,
      fat_g: Math.round(num(it.fat_g) * 10) / 10,
    }));
  if (!items.length) return null;

  return {
    items,
    confidence: ['low', 'medium', 'high'].includes(parsed.confidence) ? parsed.confidence : 'low',
    note: typeof parsed.note === 'string' ? parsed.note.slice(0, 300) : '',
  };
}
