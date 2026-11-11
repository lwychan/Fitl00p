// Called from the FitLoop app (signed in) when logging food from photos.
// Estimates calories/macros with Cloudflare Workers AI
// (@cf/meta/llama-3.2-11b-vision-instruct), using the free daily Neuron
// allowance. Up to 3 "before" photos of one plate from different angles,
// plus an optional "after" photo of the leftovers (before minus after).
//
// GET  → today's quota only (drives the battery gauge on page load).
// POST → estimate; response includes the updated quota.
//
// The allowance is shared by the whole Cloudflare account, so the ledger
// is one row per UTC day (public.workers_ai_daily_usage, written through
// add_workers_ai_neurons). The number is our own sum of the Neurons each
// call reports, so it can differ slightly from Cloudflare's dashboard.

const SB_URL     = Deno.env.get('SUPABASE_URL');
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const CF_ACCOUNT = Deno.env.get('CLOUDFLARE_ACCOUNT_ID');
const CF_TOKEN   = Deno.env.get('CLOUDFLARE_API_TOKEN');

const CF_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
// Cloudflare's free Workers AI allowance per day (UTC).
const DAILY_NEURON_LIMIT = 10000;
// Stop a single call from starting if it could push us past the limit.
// A plate estimate costs roughly 10–30 Neurons, so this is a safety margin.
const MIN_HEADROOM_NEURONS = 50;

const ALLOWED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_B64 = 7_000_000;
const MAX_ANGLES = 3;

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: HEADERS });

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function quotaFrom(used: number) {
  const u = Math.max(0, Number(used) || 0);
  const remaining = Math.max(0, DAILY_NEURON_LIMIT - u);
  return {
    day: todayUtc(),
    used: Math.round(u * 100) / 100,
    limit: DAILY_NEURON_LIMIT,
    remaining: Math.round(remaining * 100) / 100,
    percent: Math.round((remaining / DAILY_NEURON_LIMIT) * 100),
  };
}

async function readUsedToday(): Promise<number> {
  const res = await fetch(`${SB_URL}/rest/v1/workers_ai_daily_usage?day=eq.${todayUtc()}&select=neurons`, {
    headers: { 'apikey': SB_SERVICE!, 'Authorization': `Bearer ${SB_SERVICE}` },
  });
  if (!res.ok) throw new Error('Could not read usage ledger');
  const rows = await res.json();
  return rows.length ? Number(rows[0].neurons) : 0;
}

async function addNeuronsToday(neurons: number): Promise<number> {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/add_workers_ai_neurons`, {
    method: 'POST',
    headers: {
      'apikey': SB_SERVICE!, 'Authorization': `Bearer ${SB_SERVICE}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_day: todayUtc(), p_neurons: neurons }),
  });
  if (!res.ok) throw new Error('Could not record usage');
  return Number(await res.json());
}

// Llama is asked for bare JSON but sometimes wraps it in a ```json fence.
export function parseEstimateJson(text: string) {
  const cleaned = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
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
  if (typeof parsed.food_name === 'string' && parsed.food_name.trim()) {
    result.food_name = parsed.food_name.trim().slice(0, 200);
  }
  return result;
}

function buildPrompt(description: string, angles: number, hasAfter: boolean): string {
  const desc = description ? JSON.stringify(String(description).slice(0, 500)) : '(none given)';
  const angleNote = angles > 1
    ? ` The ${angles} BEFORE photos are different angles of ONE plate. Use them together; some items only show from certain angles. Do not double-count an item that appears in more than one photo.`
    : '';
  const head = `You are estimating calories and macronutrients for a food diary entry.
User's description: ${desc}.
The first ${angles} image(s) show the meal as served.${angleNote}`;
  const afterPart = hasAfter
    ? `
The LAST image shows the leftovers afterwards. Work out what was eaten:
1. List each distinct food item in the served photos with a count or portion (e.g. "2 pork chops", "4 salami slices").
2. For the SAME items, count how much is still on the plate. Count countable items; do not guess a vague fraction.
3. Subtract to get what was eaten, and total calories/macros for only that eaten portion.`
    : `
Estimate the whole plate as served. List each item with a count or portion, then total the calories and macros.`;
  return `${head}${afterPart}

Reply with ONLY a JSON object, no other text:
{"food_name": "<only if a product/label title is clearly visible, else omit>", "calories_kcal": <number>, "protein_g": <number>, "carbs_g": <number>, "fat_g": <number>, "confidence": "low"|"medium"|"high", "note": "<one short sentence: the items and portions you counted, and anything uncertain>"}
Never refuse. If unsure, give your best estimate and lower the confidence.`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS });
  if (req.method !== 'GET' && req.method !== 'POST') return json(405, { error: 'GET or POST only' });
  if (!SB_URL || !SB_SERVICE) return json(500, { error: 'Server not configured' });

  // Same Supabase-JWT check as the other functions: this spends a paid-
  // quota allowance per call, so it isn't left open.
  const authHeader = req.headers.get('authorization') || req.headers.get('Authorization') || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return json(401, { error: 'Not authenticated' });
  const userRes = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${jwt}`, 'apikey': SB_SERVICE },
  });
  if (!userRes.ok) return json(401, { error: 'Invalid session' });

  let usedToday: number;
  try {
    usedToday = await readUsedToday();
  } catch (e) {
    return json(502, { error: (e as Error).message });
  }

  if (req.method === 'GET') return json(200, { quota: quotaFrom(usedToday) });

  if (!CF_ACCOUNT || !CF_TOKEN) return json(500, { error: 'Cloudflare not configured on the server' });

  let body: any;
  try {
    body = JSON.parse((await req.text()) || '{}');
  } catch (e) {
    return json(400, { error: 'Invalid JSON: ' + (e as Error).message });
  }

  const { images, description, image_base64_after, media_type_after } = body;
  if (!Array.isArray(images) || images.length === 0) return json(400, { error: 'images (at least one photo) is required' });
  if (images.length > MAX_ANGLES) return json(400, { error: `Up to ${MAX_ANGLES} photos per meal` });
  for (const img of images) {
    if (!img || !img.base64 || !img.media_type) return json(400, { error: 'each image needs base64 and media_type' });
    if (!ALLOWED_MEDIA_TYPES.includes(img.media_type)) return json(400, { error: `media_type must be one of ${ALLOWED_MEDIA_TYPES.join(', ')}` });
    if (img.base64.length > MAX_IMAGE_B64) return json(400, { error: 'Image too large — resize before uploading' });
  }
  const hasAfter = !!image_base64_after;
  if (hasAfter) {
    if (!ALLOWED_MEDIA_TYPES.includes(media_type_after)) return json(400, { error: `media_type_after must be one of ${ALLOWED_MEDIA_TYPES.join(', ')}` });
    if (image_base64_after.length > MAX_IMAGE_B64) return json(400, { error: 'After photo too large — resize before uploading' });
  }

  // Refuse before calling when today's allowance is effectively spent.
  if (usedToday >= DAILY_NEURON_LIMIT - MIN_HEADROOM_NEURONS) {
    return json(429, { error: "Today's free photo-estimate allowance is used up — it resets at midnight UTC. You can still enter the food manually.", quota: quotaFrom(usedToday) });
  }

  const dataUrl = (b64: string, type: string) => `data:${type};base64,${b64}`;
  const content: any[] = [{ type: 'text', text: buildPrompt(description, images.length, hasAfter) }];
  for (const img of images) content.push({ type: 'image_url', image_url: { url: dataUrl(img.base64, img.media_type) } });
  if (hasAfter) content.push({ type: 'image_url', image_url: { url: dataUrl(image_base64_after, media_type_after) } });

  let cfRes: Response;
  try {
    cfRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${CF_MODEL}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content }], max_tokens: 512, temperature: 0.2 }),
    });
  } catch (e) {
    return json(502, { error: 'Estimator unreachable: ' + (e as Error).message });
  }
  const cfBody: any = await cfRes.json().catch(() => ({}));
  if (!cfRes.ok || !cfBody.success) {
    const msg = cfBody?.errors?.[0]?.message || `Estimator error (${cfRes.status})`;
    return json(502, { error: msg });
  }

  const result = cfBody.result || {};
  const neurons = Number(result.usage?.neurons) || 0;
  let newTotal = usedToday + neurons;
  try {
    newTotal = await addNeuronsToday(neurons);
  } catch {
    // The estimate is still valid; the gauge will catch up on the next read.
  }

  const estimate = parseEstimateJson(result.response);
  if (!estimate) return json(502, { error: 'Estimator reply could not be read — enter the numbers manually.', quota: quotaFrom(newTotal) });

  return json(200, { ...estimate, quota: quotaFrom(newTotal) });
});
