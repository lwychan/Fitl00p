// netlify/functions/food-photo-estimate.js
// Called from the fitl00p app (authenticated) when logging food via photo
// instead of a barcode scan or database search — asks Claude to estimate
// calories/macros from a photo + a short text description. Openly
// approximate (same framing as the rest of this app's estimates) — the
// UI pre-fills the returned numbers into an editable form rather than
// logging them directly, so the person reviews/adjusts before saving.

const SB_URL     = process.env.SUPABASE_URL;
const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL   = 'claude-haiku-4-5-20251001'; // fast + cheap — a good fit for a small structured-JSON estimate, not a task that needs deep reasoning

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

  // ── Authenticate — same Supabase-JWT pattern as health-apikey.js.
  // This calls a paid API per request, so (unlike the read-only proxies
  // elsewhere in this folder) it deliberately isn't left open.
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

  const { image_base64, media_type, description } = body;
  if (!image_base64 || !media_type) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'image_base64 and media_type are required' }) };
  }
  const ALLOWED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  if (!ALLOWED_MEDIA_TYPES.includes(media_type)) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: `media_type must be one of ${ALLOWED_MEDIA_TYPES.join(', ')}` }) };
  }
  // Base64 is ~4/3 the size of the decoded bytes — 7MB of base64 is
  // roughly a 5MB image, comfortably past what a compressed food photo
  // should ever need and a sane cap against an oversized upload.
  if (image_base64.length > 7_000_000) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Image too large — resize before uploading' }) };
  }

  const prompt = `You are estimating calories and macronutrients for a food diary entry, from a photo and a short description.

Description from the user: ${description ? JSON.stringify(String(description).slice(0, 500)) : '(none given)'}

Look at the photo and give your best-effort estimate of the TOTAL meal shown (or described, if the photo is unclear/partial) — portion size, cooking method, and visible ingredients all matter. Never refuse to estimate; if you're unsure, give your best guess and say so in "note" with a lower "confidence".

Respond with ONLY a single JSON object, no markdown fences, no other text, in exactly this shape:
{"calories_kcal": <number>, "protein_g": <number>, "carbs_g": <number>, "fat_g": <number>, "confidence": "low"|"medium"|"high", "note": "<one short sentence on your key assumptions, e.g. portion size or ingredients guessed>"}`;

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
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type, data: image_base64 } },
            { type: 'text', text: prompt },
          ],
        }],
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
  const num = v => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);
  if (parsed.calories_kcal == null) return null;
  return {
    calories_kcal: Math.round(num(parsed.calories_kcal)),
    protein_g: Math.round(num(parsed.protein_g)),
    carbs_g: Math.round(num(parsed.carbs_g)),
    fat_g: Math.round(num(parsed.fat_g)),
    confidence: ['low', 'medium', 'high'].includes(parsed.confidence) ? parsed.confidence : 'low',
    note: typeof parsed.note === 'string' ? parsed.note.slice(0, 300) : '',
  };
}
