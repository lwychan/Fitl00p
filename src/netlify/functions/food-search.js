// netlify/functions/food-search.js
// Proxies Open Food Facts' text-search API server-side. Log Food's Search
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

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=300',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS };

  const query = (event.queryStringParameters?.q || '').trim();
  if (query.length < 2) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing or too-short q parameter' }) };

  const searchUrl = `https://search.openfoodfacts.org/search?${new URLSearchParams({
    q: query,
    page_size: '15',
    fields: 'code,product_name,brands,nutriments',
  })}`;

  let hits;
  try {
    const res = await fetch(searchUrl, {
      headers: {
        // Bare curl/Node UAs get a "temporarily unavailable" page from
        // this endpoint — a normal browser UA gets real results through.
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      },
    });
    if (!res.ok) return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: `Open Food Facts search failed: HTTP ${res.status}` }) };
    const data = await res.json();
    hits = data.hits || [];
  } catch (err) {
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: 'Open Food Facts search failed: ' + err.message }) };
  }

  // Same per-100g shape populateLfFormFromFood() in app.js already
  // expects from a barcode-scanned OFF product — the review form doesn't
  // need to know whether a result came from a scan or a text search.
  const results = hits
    .map(p => {
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

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ results }) };
};
