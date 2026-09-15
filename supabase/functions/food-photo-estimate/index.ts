// Called from the fitl00p app (authenticated) when logging food via photo
// instead of a barcode scan or database search — asks Claude to estimate
// calories/macros from a photo + a short text description. Openly
// approximate (same framing as the rest of this app's estimates) — the
// UI pre-fills the returned numbers into an editable form rather than
// logging them directly, so the person reviews/adjusts before saving.
//
// Ported from src/netlify/functions/food-photo-estimate.js — mechanical
// translation to Deno.serve; logic unchanged.

const SB_URL     = Deno.env.get('SUPABASE_URL');
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_KEY');
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
// A single-photo estimate is a good fit for Haiku — fast/cheap, no
// cross-image reasoning needed. A before/after (leftovers) estimate
// needs to actually count matching items across two photos and compare
// them (e.g. "4 salami slices before, 2 still on the plate after" —
// Haiku was observed calling that "minimal remains" and barely
// discounting the estimate) — worth Sonnet's extra cost for the more
// careful visual comparison that requires.
const ANTHROPIC_MODEL_SINGLE       = 'claude-haiku-4-5-20251001';
const ANTHROPIC_MODEL_BEFORE_AFTER = 'claude-sonnet-5';

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

// Claude is asked for bare JSON but occasionally still wraps it in a
// ```json fence anyway — strip that before parsing rather than failing.
function parseEstimateJson(text: string) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);
  if (parsed.calories_kcal == null) return null;
  const result: any = {
    calories_kcal: Math.round(num(parsed.calories_kcal)),
    protein_g: Math.round(num(parsed.protein_g)),
    carbs_g: Math.round(num(parsed.carbs_g)),
    fat_g: Math.round(num(parsed.fat_g)),
    confidence: ['low', 'medium', 'high'].includes(parsed.confidence) ? parsed.confidence : 'low',
    note: typeof parsed.note === 'string' ? parsed.note.slice(0, 300) : '',
  };
  // Only present when a title was actually read off a label/screenshot —
  // the client uses this to prefill the food name instead of falling
  // back to the photo description, but only when there's a real title.
  if (typeof parsed.food_name === 'string' && parsed.food_name.trim()) {
    result.food_name = parsed.food_name.trim().slice(0, 200);
  }
  return result;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: HEADERS });
  }
  if (!ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured on the server' }), { status: 500, headers: HEADERS });
  }
  if (!SB_URL || !SB_SERVICE) {
    return new Response(JSON.stringify({ error: 'Server not configured' }), { status: 500, headers: HEADERS });
  }

  // ── Authenticate — same Supabase-JWT pattern used across these
  // functions. This calls a paid API per request, so (unlike the
  // read-only proxies elsewhere) it deliberately isn't left open.
  const authHeader = req.headers.get('authorization') || req.headers.get('Authorization') || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers: HEADERS });
  const userRes = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${jwt}`, 'apikey': SB_SERVICE },
  });
  if (!userRes.ok) return new Response(JSON.stringify({ error: 'Invalid session' }), { status: 401, headers: HEADERS });

  let body: any;
  try {
    body = JSON.parse((await req.text()) || '{}');
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON: ' + (e as Error).message }), { status: 400, headers: HEADERS });
  }

  const { images, description, image_base64_after, media_type_after } = body;
  const ALLOWED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  // "images" is the meal as served — normally one photo, but the client
  // may send up to 3, taken from different angles of the same plate, so
  // Claude can see items a single angle hides (food at the back of a
  // bowl, underneath something else) rather than just guessing at them.
  if (!Array.isArray(images) || images.length === 0) {
    return new Response(JSON.stringify({ error: 'images (at least one photo) is required' }), { status: 400, headers: HEADERS });
  }
  if (images.length > 3) {
    return new Response(JSON.stringify({ error: 'Up to 3 photos per meal' }), { status: 400, headers: HEADERS });
  }
  for (const img of images) {
    if (!img || !img.base64 || !img.media_type) {
      return new Response(JSON.stringify({ error: 'each image needs base64 and media_type' }), { status: 400, headers: HEADERS });
    }
    if (!ALLOWED_MEDIA_TYPES.includes(img.media_type)) {
      return new Response(JSON.stringify({ error: `media_type must be one of ${ALLOWED_MEDIA_TYPES.join(', ')}` }), { status: 400, headers: HEADERS });
    }
    // Base64 is ~4/3 the size of the decoded bytes — 7MB of base64 is
    // roughly a 5MB image, comfortably past what a compressed food photo
    // should ever need and a sane cap against an oversized upload.
    if (img.base64.length > 7_000_000) {
      return new Response(JSON.stringify({ error: 'Image too large — resize before uploading' }), { status: 400, headers: HEADERS });
    }
  }

  // "After" photo (leftovers) is optional — when present, this becomes a
  // before/after estimate of what was actually eaten rather than an
  // estimate of the whole plate as served.
  const hasAfterPhoto = !!image_base64_after;
  if (hasAfterPhoto) {
    if (!media_type_after || !ALLOWED_MEDIA_TYPES.includes(media_type_after)) {
      return new Response(JSON.stringify({ error: `media_type_after must be one of ${ALLOWED_MEDIA_TYPES.join(', ')}` }), { status: 400, headers: HEADERS });
    }
    if (image_base64_after.length > 7_000_000) {
      return new Response(JSON.stringify({ error: 'After photo too large — resize before uploading' }), { status: 400, headers: HEADERS });
    }
  }

  const multiAngle = images.length > 1;
  const beforeLabel = multiAngle ? `the ${images.length} BEFORE photos (different angles of the same served meal)` : 'the BEFORE photo';
  const angleNote = multiAngle ? ' Use the angles together to see the full plate — some items are only visible from certain angles (food at the back of a bowl, underneath something else). They show ONE meal, not separate meals — do not double-count an item just because it appears in more than one photo.' : '';

  const prompt = hasAfterPhoto ? `You are estimating calories and macronutrients ACTUALLY CONSUMED for a food diary entry, from photos of the same meal and a short description.

Description from the user: ${description ? JSON.stringify(String(description).slice(0, 500)) : '(none given)'}

You are shown ${beforeLabel}, showing the meal as served (before eating).${angleNote} The FINAL photo shows what's left on the plate afterward (leftovers, if any — it may be empty or near-empty if everything was eaten, or substantial if a lot was left).

Work through this explicitly before answering:
1. List each distinct food item visible across the BEFORE photo(s), with a count or portion size for each (e.g. "2 pork chops", "4 salami slices", "1 slice of cheese").
2. For that SAME list of items, count or estimate how much of each is still visible in the leftovers photo. Countable items (slices, pieces, chops) must be counted, not eyeballed as a vague fraction — if 4 slices were served and 2 whole slices remain, that is HALF of that item left, not "minimal remains". Look carefully — leftovers are frequently substantial, not just crumbs.
3. Subtract, per item, to get what was actually eaten, then total the calories/macros for only that eaten portion.

Portion size, cooking method, and visible ingredients all matter across all photos. Never refuse to estimate; if you're unsure, give your best guess and say so in "note" with a lower "confidence".

Respond with ONLY a single JSON object, no markdown fences, no other text, in exactly this shape:
{"calories_kcal": <number>, "protein_g": <number>, "carbs_g": <number>, "fat_g": <number>, "confidence": "low"|"medium"|"high", "note": "<one short sentence naming what was left over and how much, e.g. '2 of 4 salami slices left uneaten'>"}` : `${multiAngle ? `Look at the ${images.length} photos below` : 'Look at the photo below'} and first work out which of these two cases it is:

CASE A — a screenshot of printed nutrition facts (a food-tracking app's "Save Recipe"/nutrition screen, a packaging nutrition label, a diary entry's macro breakdown — printed digits and labels, not a photographed plate of food). If so, do NOT estimate anything: read and transcribe the EXACT numbers shown for calories, protein, carbs, and fat FOR ONE SERVING (use the "per serving" figures if a serving size/count is shown, not a multi-serving total). Also read off the recipe/food title if one is visible, as "food_name" (omit "food_name" entirely if no title is visible). Set "confidence" to "high" and "note" to something like "Read directly from a nutrition label screenshot." — you are transcribing printed facts, not guessing.

CASE B — an actual photograph of real food (a plate, a bowl, a wrapper with food in/on it). If so, estimate as normal: give your best-effort visual estimate of the TOTAL meal shown${multiAngle ? ', using all the angles together — they show the SAME meal, not separate meals; do not double-count an item just because it appears in more than one photo' : ''} (or described, if the photo is unclear/partial) — portion size, cooking method, and visible ingredients all matter. Never refuse to estimate; if you're unsure, give your best guess and say so in "note" with a lower "confidence". Do not include "food_name" in this case unless the user's description names the meal.

Description from the user: ${description ? JSON.stringify(String(description).slice(0, 500)) : '(none given)'}

Respond with ONLY a single JSON object, no markdown fences, no other text, in exactly this shape:
{"calories_kcal": <number>, "protein_g": <number>, "carbs_g": <number>, "fat_g": <number>, "confidence": "low"|"medium"|"high", "note": "<one short sentence — either what was transcribed from, or your key assumptions>", "food_name": "<optional — only include this key at all when a title was actually visible to read>"}`;

  const imageContent: any[] = [];
  images.forEach((img: any, i: number) => {
    if (multiAngle) imageContent.push({ type: 'text', text: hasAfterPhoto ? `Before-eating photo, angle ${i + 1} of ${images.length}:` : `Photo ${i + 1} of ${images.length} — same meal, different angle:` });
    imageContent.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.base64 } });
  });
  if (hasAfterPhoto) {
    imageContent.push({ type: 'text', text: 'After eating (leftovers, if any):' });
    imageContent.push({ type: 'image', source: { type: 'base64', media_type: media_type_after, data: image_base64_after } });
  }

  let anthropicRes: Response;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: hasAfterPhoto ? ANTHROPIC_MODEL_BEFORE_AFTER : ANTHROPIC_MODEL_SINGLE,
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [...imageContent, { type: 'text', text: prompt }],
        }],
      }),
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Could not reach Claude: ' + (err as Error).message }), { status: 502, headers: HEADERS });
  }

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text().catch(() => '');
    return new Response(JSON.stringify({ error: `Claude API error (${anthropicRes.status}): ${errText.slice(0, 300)}` }), { status: 502, headers: HEADERS });
  }

  const data = await anthropicRes.json();
  const rawText = (data?.content || []).map((c: any) => c.text || '').join('').trim();

  const estimate = parseEstimateJson(rawText);
  if (!estimate) {
    return new Response(JSON.stringify({ error: "Couldn't parse an estimate from Claude's response", raw: rawText.slice(0, 300) }), { status: 502, headers: HEADERS });
  }

  return new Response(JSON.stringify(estimate), { status: 200, headers: HEADERS });
});
