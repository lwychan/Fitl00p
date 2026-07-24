// mfp-bookmarklet-payload.js — the actual MyFitnessPal diary parser.
//
// This used to be inlined directly into the bookmarklet's javascript: URL,
// but that URL grew to ~4.5KB, which iOS Safari bookmarks (and iCloud
// bookmark sync in particular) are known to silently truncate or corrupt —
// producing exactly "nothing happens when I tap it" with no error visible
// anywhere, since a mangled URL never even reaches this code. The
// bookmarklet is now a ~200-byte loader (see buildMfpBookmarklet() in
// app.js) that just injects a <script src="…/mfp-bookmarklet-payload.js">
// tag — short enough to survive being saved as an iOS bookmark — and this
// file does the real work. The loader sets window.__FITL00P_TOKEN__ and
// window.__FITL00P_ENDPOINT__ as globals before injecting the tag, since
// this file (unlike the old inline version) can't have per-user values
// baked in — it's one static file served to every user.
//
// IMPORTANT: keep this in sync with MFP_SHORTCUT_SRC in app.js by hand —
// the Shortcuts variant has its own copy (it can't use this loader
// pattern, since Shortcuts' "Run JavaScript on Web Page" action wants a
// plain script string, not something that fetches a second file, and
// isn't token-length-constrained the way a URL is).
(function () {
  var TOKEN = window.__FITL00P_TOKEN__;
  var ENDPOINT = window.__FITL00P_ENDPOINT__;
  if (!TOKEN || !ENDPOINT) {
    alert('fitl00p: bookmarklet loader did not set the token/endpoint — try re-copying the bookmarklet from Settings.');
    return;
  }

  function num(text) {
    if (text == null) return null;
    var m = String(text).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }
  function numFromCell(cell) {
    if (!cell) return null;
    var whole = cell.querySelector('.macro-value');
    if (whole) {
      var dec = cell.querySelector('.macro-percentage');
      var s = (whole.textContent || '').trim() + (dec ? '.' + (dec.textContent || '').trim() : '');
      var v = parseFloat(s);
      return isNaN(v) ? null : v;
    }
    return num(cell.textContent);
  }
  function sectionName(numStr) {
    var names = { '1': 'breakfast', '2': 'lunch', '3': 'dinner', '4': 'snacks', '5': 'snacks', '6': 'snacks' };
    return names[numStr] || 'snacks';
  }

  // MFP diary pages don't have a '.date-picker input' — that selector was
  // fitl00p's OWN CSS class name, mistaken for something that'd also
  // exist on MFP's page, so it silently never matched and this always
  // fell through to "today" — even when viewing a past day's diary. The
  // reliable source is the URL itself: MFP diary pages are
  // myfitnesspal.com/food/diary/<user>?date=YYYY-MM-DD. Text-parsing the
  // "Food Diary For: <date>" heading is the fallback if the URL is ever
  // missing the param, with "today" only as a last resort.
  function detectDiaryDate() {
    try {
      var urlDate = new URL(location.href).searchParams.get('date');
      if (urlDate && /^\d{4}-\d{2}-\d{2}$/.test(urlDate)) return urlDate;
    } catch (e) {}
    var headingMatch = (document.body.innerText || '').match(/Food Diary For:\s*([A-Za-z]+,?\s*[A-Za-z]+\s+\d{1,2},?\s+\d{4})/);
    if (headingMatch) {
      var parsed = new Date(headingMatch[1]);
      if (!isNaN(parsed.getTime())) {
        return parsed.getFullYear() + '-' + String(parsed.getMonth() + 1).padStart(2, '0') + '-' + String(parsed.getDate()).padStart(2, '0');
      }
    }
    return new Date().toISOString().slice(0, 10);
  }

  // MFP diary sections normally get combined into one fitl00p entry per
  // meal (one carb/fat/protein total instead of N slivers) \u2014 but a
  // "Sugar" section is used for ad-hoc hypo-treatment sweets logged
  // throughout the day, not a meal, so those import as individual items
  // instead, each matched/dosed on its own.
  function isSugarSection(label) {
    return /^sugar$/i.test((label || '').trim());
  }

  var items = [];
  var rows = document.querySelectorAll('#diary-table tr');
  var section = 'breakfast';
  var sectionLabel = 'Breakfast';
  var sectionItems = []; // { name, calories, carbsG, fatG, proteinG }
  function flushSection(totalsRow) {
    if (!sectionItems.length) return;
    if (isSugarSection(sectionLabel)) {
      for (var i = 0; i < sectionItems.length; i++) {
        var it = sectionItems[i];
        if (it.carbsG != null || it.fatG != null || it.proteinG != null || it.calories != null) {
          items.push({ mealSection: section, name: it.name, carbsG: it.carbsG, fatG: it.fatG, proteinG: it.proteinG, calories: it.calories });
        }
      }
      sectionItems = [];
      return;
    }
    var cells = totalsRow.querySelectorAll('td');
    var calories = numFromCell(cells[1]);
    var carbsG = numFromCell(cells[2]);
    var fatG = numFromCell(cells[3]);
    var proteinG = numFromCell(cells[4]);
    if (carbsG != null || fatG != null || proteinG != null || calories != null) {
      var names = sectionItems.map(function (it) { return it.name; });
      items.push({ mealSection: section, name: sectionLabel + ' \u2014 ' + names.join(', '), carbsG: carbsG, fatG: fatG, proteinG: proteinG, calories: calories });
    }
    sectionItems = [];
  }
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var cls = row.className || '';
    if (/meal_header/i.test(cls)) {
      var headCell = row.querySelector('td');
      var rawSection = headCell ? (headCell.textContent || '').trim() : '';
      section = sectionName(rawSection);
      sectionLabel = rawSection && !/^\d+$/.test(rawSection) ? rawSection : (section.charAt(0).toUpperCase() + section.slice(1));
      sectionItems = [];
      continue;
    }
    if (/bottom|total/i.test(cls)) {
      flushSection(row);
      continue;
    }
    var cells = row.querySelectorAll('td');
    if (cells.length < 7) continue;
    var rawName = (cells[0].textContent || '').trim();
    if (!rawName) continue;
    var name = rawName.replace(/\s*\/?,\s*[\d.]+\s*[a-zA-Z%]*\s*$/, '').trim() || rawName;
    sectionItems.push({
      name: name,
      calories: numFromCell(cells[1]),
      carbsG: numFromCell(cells[2]),
      fatG: numFromCell(cells[3]),
      proteinG: numFromCell(cells[4]),
    });
  }

  if (!items.length) {
    alert("fitl00p: no food rows found. Make sure you're on your own MFP diary page (myfitnesspal.com/food/diary) with food logged today.");
    return;
  }

  function macroStr(it) {
    var parts = [];
    if (it.carbsG != null) parts.push(it.carbsG + 'g carbs');
    if (it.fatG != null) parts.push(it.fatG + 'g fat');
    if (it.proteinG != null) parts.push(it.proteinG + 'g protein');
    return parts.length ? ' (' + parts.join(', ') + ')' : ' (no macro figures — turn on Carbs/Fat/Protein columns in MFP Diary Settings for better matching)';
  }
  var preview = items.slice(0, 8).map(function (it) {
    return '- ' + it.name + macroStr(it);
  }).join('\n') + (items.length > 8 ? '\n…and ' + (items.length - 8) + ' more' : '');
  if (!confirm('Send ' + items.length + ' item(s) to fitl00p?\n\n' + preview)) return;

  var dateVal = detectDiaryDate();

  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: TOKEN, date: dateVal, items: items }),
  }).then(function (r) { return r.json(); }).then(function (res) {
    if (res.error) { alert('fitl00p import failed: ' + res.error + (res.detail ? '\n\n' + res.detail : '')); return; }
    var lines = (res.suggestions || []).map(function (s) {
      if (s.suggestedUnits != null) {
        var line = s.name + ': ' + s.suggestedUnits + 'u';
        if (s.splitTier && s.splitTier !== 'single' && s.delayedUnits > 0) {
          line += ' (' + s.upfrontUnits + 'u now, ' + s.delayedUnits + 'u delayed)';
        }
        if (s.lowGlucoseWarning) line += ' \u26a0 glucose is low — double-check before dosing';
        return line;
      }
      if (s.hypoTreatment) return s.name + ': hypo treatment — no bolus needed';
      if (s.withheldReason) return s.name + ': no suggestion (' + s.withheldReason + ') — check the Diabetes tab';
      return null;
    }).filter(Boolean);
    var summary = res.autoMatched + ' already matched to an existing bolus' + (res.skippedDuplicate ? ', ' + res.skippedDuplicate + ' already sent before' : '') + '.';
    alert('fitl00p:\n\n' + (lines.length ? lines.join('\n\n') : 'Nothing new to suggest.') + '\n\n' + summary);
  }).catch(function (err) {
    alert('fitl00p import failed: ' + err.message);
  });
})();
