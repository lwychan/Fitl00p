// Food tab search, server-side: Open Food Facts (branded products) and USDA
// FoodData Central (generic foods), queried in parallel — see the two
// search* functions at the bottom. History of the OFF half: Log Food's Search
// mode only ever queried custom_foods (the household's own previously
// scanned/added items) — a common product neither of them had scanned
// before (e.g. a specific juice/smoothie) always came back "No matches",
// even though OFF almost certainly has it.
//
// Can't be a plain client-side fetch like the barcode lookup in app.js
// (world.openfoodfacts.org/api/v2/product/... — CORS-open, keyless) is:
// OFF's newer search API lives on a different host
// (search.openfoodfacts.org) that sends no Access-Control-Allow-Origin
// header at all, so a browser blocks it outright. Routing it through this
// function sidesteps that the same way every other third-party pull in
// this app does when the source itself isn't CORS-open.
//
// Ported from src/netlify/functions/food-search.js — mechanical
// translation to Deno.serve; logic unchanged.

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  // The app sends Authorization (anon key) from its bundled origin, which
  // makes the request preflighted — without these the preflight returned
  // 204 but the browser never sent the real GET (same bug as diabetes-sync).
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=300',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS });

  const query = (new URL(req.url).searchParams.get('q') || '').trim();
  if (query.length < 2) return new Response(JSON.stringify({ error: 'Missing or too-short q parameter' }), { status: 400, headers: HEADERS });

  // Both sources in parallel; one failing still returns the other's hits.
  const [off, usda] = await Promise.allSettled([searchOpenFoodFacts(query), searchUsda(query)]);
  if (off.status === 'rejected' && usda.status === 'rejected') {
    return new Response(JSON.stringify({ error: 'Food search failed: ' + (off.reason as Error).message }), { status: 502, headers: HEADERS });
  }
  if (off.status === 'rejected') console.error('food-search OFF:', (off.reason as Error).message);
  if (usda.status === 'rejected') console.error('food-search USDA:', (usda.reason as Error).message);

  return new Response(JSON.stringify({
    results: off.status === 'fulfilled' ? off.value : [],   // branded products (Open Food Facts)
    generic: usda.status === 'fulfilled' ? usda.value : [], // whole/generic foods (USDA)
  }), { status: 200, headers: HEADERS });
});

// Branded products. Same per-100g shape populateLfFormFromFood() in app.js
// already expects from a barcode-scanned OFF product.
async function searchOpenFoodFacts(query: string) {
  const searchUrl = `https://search.openfoodfacts.org/search?${new URLSearchParams({
    q: query,
    page_size: '15',
    fields: 'code,product_name,brands,nutriments',
  })}`;
  const res = await fetch(searchUrl, {
    headers: {
      // Bare curl/Node UAs get a "temporarily unavailable" page from
      // this endpoint — a normal browser UA gets real results through.
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    },
  });
  if (!res.ok) throw new Error(`Open Food Facts HTTP ${res.status}`);
  const hits: any[] = (await res.json()).hits || [];
  return hits
    .map((p: any) => {
      const n = p.nutriments || {};
      const cals = n['energy-kcal_100g'] ?? (n['energy_100g'] != null ? n['energy_100g'] / 4.184 : null);
      if (cals == null || !p.product_name) return null; // no usable nutrition data or no name — not worth showing
      return {
        name: p.product_name,
        brand: Array.isArray(p.brands) ? p.brands.join(', ') : (p.brands || null),
        serving_desc: '100g',
        serving_qty: 100,
        serving_unit: 'g',
        calories_kcal: Math.round(cals),
        protein_g: Math.round((n.proteins_100g || 0) * 10) / 10,
        carbs_g: Math.round((n.carbohydrates_100g || 0) * 10) / 10,
        fat_g: Math.round((n.fat_100g || 0) * 10) / 10,
        barcode: p.code || null,
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

// Generic foods ("Bananas, raw", "Chicken, breast, roasted") from USDA
// FoodData Central — the reference datasets only (Foundation, SR Legacy),
// whose nutrients are per 100 g. Free key from api.data.gov in the
// FDC_API_KEY secret; DEMO_KEY (10 requests/hour) until one is set.
const FDC_API_KEY = Deno.env.get('FDC_API_KEY') || 'DEMO_KEY';
const FDC_NUTRIENT = { energyKcal: 1008, atwaterGeneral: 2047, atwaterSpecific: 2048, energyKj: 1062, protein: 1003, carbs: 1005, fat: 1004 };

async function searchUsda(query: string) {
  const url = `https://api.nal.usda.gov/fdc/v1/foods/search?${new URLSearchParams({
    query,
    pageSize: '10',
    dataType: 'Foundation,SR Legacy',
    api_key: FDC_API_KEY,
  })}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`USDA HTTP ${res.status}`);
  const foods: any[] = (await res.json()).foods || [];
  return foods
    .map((f: any) => {
      const n: Record<number, number> = {};
      for (const x of f.foodNutrients || []) if (typeof x.value === 'number') n[x.nutrientId] = x.value;
      const cals = n[FDC_NUTRIENT.energyKcal] ?? n[FDC_NUTRIENT.atwaterGeneral] ?? n[FDC_NUTRIENT.atwaterSpecific]
        ?? (n[FDC_NUTRIENT.energyKj] != null ? n[FDC_NUTRIENT.energyKj] / 4.184 : null);
      if (cals == null || !f.description) return null;
      return {
        name: f.description,
        brand: null,
        serving_desc: '100g',
        serving_qty: 100,
        serving_unit: 'g',
        calories_kcal: Math.round(cals),
        protein_g: Math.round((n[FDC_NUTRIENT.protein] || 0) * 10) / 10,
        carbs_g: Math.round((n[FDC_NUTRIENT.carbs] || 0) * 10) / 10,
        fat_g: Math.round((n[FDC_NUTRIENT.fat] || 0) * 10) / 10,
        barcode: null,
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}
