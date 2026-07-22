// netlify/functions/mfp-sync.js
// Fetches a public MyFitnessPal diary page and parses meal totals.
// No credentials required — diary must be set to Public in MFP settings.

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers };
  }

  const { username, date } = event.queryStringParameters || {};

  if (!username) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing username parameter.' }) };
  }

  // date defaults to today (UTC)
  const targetDate = date || new Date().toISOString().slice(0, 10);

  const url = `https://www.myfitnesspal.com/food/diary/${encodeURIComponent(username)}?date=${targetDate}`;

  let html;
  try {
    const res = await fetch(url, {
      headers: {
        // Appear as a normal browser request
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
    });

    if (res.status === 404) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: `MFP user "${username}" not found. Check the username is correct.` }) };
    }
    if (!res.ok) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: `MFP returned status ${res.status}. Try again shortly.` }) };
    }

    html = await res.text();
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not reach MyFitnessPal: ' + err.message }) };
  }

  // ── Check diary is public ───────────────────────────────────
  if (html.includes('This diary is private') || html.includes('diary is set to private')) {
    return {
      statusCode: 403, headers,
      body: JSON.stringify({ error: 'Your MFP diary is set to private. Go to MFP Settings → Diary Settings → Diary Privacy and set it to Public.' }),
    };
  }

  // ── Parse meal totals ───────────────────────────────────────
  // MFP diary table structure (as of 2025):
  //   <tr class="total ..."><td class="first alt">Breakfast</td>...<td class="calories">450</td>
  // We look for the "bottom-total" row per meal section, or the meal header totals.

  const result = {
    date: targetDate,
    breakfast: 0,
    lunch: 0,
    dinner: 0,
    snacks: 0,
    total: 0,
  };

  // Strategy 1: look for meal total rows
  // MFP marks each meal's total row with class="total" inside a tbody with id="meal_*"
  // Pattern: meal name in a td.first, then calories somewhere in the row

  // Extract all meal total rows
  // Each meal tbody looks like: <tbody id="meal_1"> ... <tr class="total">...</tr></tbody>
  const mealBodyRe = /<tbody[^>]+id="meal_(\d)"[^>]*>([\s\S]*?)<\/tbody>/gi;
  const calCellRe  = /class="[^"]*calories[^"]*"[^>]*>\s*([\d,]+)\s*<\/td>/i;
  const mealNameRe = /class="[^"]*first[^"]*"[^>]*>\s*([^<]+)\s*</i;
  const totalRowRe = /<tr[^>]+class="[^"]*total[^"]*"[^>]*>([\s\S]*?)<\/tr>/i;

  let mealMatch;
  let strategy1Worked = false;

  while ((mealMatch = mealBodyRe.exec(html)) !== null) {
    const mealNum  = mealMatch[1];
    const mealHtml = mealMatch[2];

    // Get the total row for this meal
    const totalRow = totalRowRe.exec(mealHtml);
    if (!totalRow) continue;

    const rowHtml = totalRow[1];

    // Get calories from the calories cell
    const calMatch = calCellRe.exec(rowHtml);
    if (!calMatch) continue;

    const cals = parseInt(calMatch[1].replace(/,/g, ''), 10);
    if (isNaN(cals)) continue;

    // Map meal number to name (MFP uses 1=Breakfast, 2=Lunch, 3=Dinner, 4+=Snacks)
    const mealMap = { '1': 'breakfast', '2': 'lunch', '3': 'dinner', '4': 'snacks', '5': 'snacks', '6': 'snacks' };
    const mealKey = mealMap[mealNum] || 'snacks';
    result[mealKey] += cals;
    strategy1Worked = true;
  }

  // Strategy 2: fallback — look for "Totals" row pattern in the main totals table
  // and meal headers with calorie counts using regex on the full HTML
  if (!strategy1Worked) {
    // Try to find meal rows by name pattern
    const mealPatterns = [
      { key: 'breakfast', re: /Breakfast[\s\S]{0,800}?class="[^"]*calories[^"]*"[^>]*>\s*([\d,]+)/i },
      { key: 'lunch',     re: /Lunch[\s\S]{0,800}?class="[^"]*calories[^"]*"[^>]*>\s*([\d,]+)/i },
      { key: 'dinner',    re: /Dinner[\s\S]{0,800}?class="[^"]*calories[^"]*"[^>]*>\s*([\d,]+)/i },
      { key: 'snacks',    re: /Snacks[\s\S]{0,800}?class="[^"]*calories[^"]*"[^>]*>\s*([\d,]+)/i },
    ];

    for (const { key, re } of mealPatterns) {
      const m = re.exec(html);
      if (m) {
        const cals = parseInt(m[1].replace(/,/g, ''), 10);
        if (!isNaN(cals)) { result[key] = cals; strategy1Worked = true; }
      }
    }
  }

  // Strategy 3: look for the "Your Daily Total" / "Totals" row for the grand total
  // as a sanity check / last resort
  const totalRowMatch = /(?:Your Daily Total|Totals)[\s\S]{0,600}?class="[^"]*calories[^"]*"[^>]*>\s*([\d,]+)/i.exec(html);
  if (totalRowMatch) {
    const grandTotal = parseInt(totalRowMatch[1].replace(/,/g, ''), 10);
    if (!isNaN(grandTotal)) result.total = grandTotal;
  }

  // Calculate total from meals if we got meal data
  const mealSum = result.breakfast + result.lunch + result.dinner + result.snacks;
  if (mealSum > 0) result.total = mealSum;

  // If nothing parsed at all, the diary might be empty or MFP changed their HTML
  if (result.total === 0 && mealSum === 0) {
    // Check if it looks like a valid diary page at all
    if (!html.includes('food-diary') && !html.includes('diary') && !html.includes('calories')) {
      return {
        statusCode: 422, headers,
        body: JSON.stringify({
          error: 'Could not parse MFP diary. The page structure may have changed — use CSV import as a fallback.',
          debug_url: url,
        }),
      };
    }
    // Valid page but no food logged
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ ...result, message: 'Diary found but no food logged for this date.' }),
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(result),
  };
};
