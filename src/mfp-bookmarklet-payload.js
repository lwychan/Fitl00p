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

  var items = [];
  var rows = document.querySelectorAll('#diary-table tr');
  var section = 'breakfast';
  var sectionLabel = 'Breakfast';
  var sectionNames = [];
  function flushSection(totalsRow) {
    if (!sectionNames.length) return;
    var cells = totalsRow.querySelectorAll('td');
    var calories = numFromCell(cells[1]);
    var carbsG = numFromCell(cells[2]);
    var fatG = numFromCell(cells[3]);
    var proteinG = numFromCell(cells[4]);
    if (carbsG != null || fatG != null || proteinG != null || calories != null) {
      items.push({ mealSection: section, name: sectionLabel + ' \u2014 ' + sectionNames.join(', '), carbsG: carbsG, fatG: fatG, proteinG: proteinG, calories: calories });
    }
    sectionNames = [];
  }
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var cls = row.className || '';
    if (/meal_header/i.test(cls)) {
      var headCell = row.querySelector('td');
      var rawSection = headCell ? (headCell.textContent || '').trim() : '';
      section = sectionName(rawSection);
      sectionLabel = rawSection && !/^\d+$/.test(rawSection) ? rawSection : (section.charAt(0).toUpperCase() + section.slice(1));
      sectionNames = [];
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
    sectionNames.push(name);
  }

  if (!items.length) {
    alert("fitl00p: no food rows found. Make sure you're on your own MFP diary page (myfitnesspal.com/food/diary) with food logged today.");
    return;
  }

  var preview = items.slice(0, 8).map(function (it) {
    return '- ' + it.name + (it.carbsG != null ? ' (' + it.carbsG + 'g carbs)' : ' (no carb figure — turn on Carbs/Fat/Protein columns in MFP Diary Settings for better matching)');
  }).join('\n') + (items.length > 8 ? '\n…and ' + (items.length - 8) + ' more' : '');
  if (!confirm('Send ' + items.length + ' item(s) to fitl00p?\n\n' + preview)) return;

  var dateInput = document.querySelector('.date-picker input, input[name="date"]');
  var dateVal = (dateInput && dateInput.value) || new Date().toISOString().slice(0, 10);

  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: TOKEN, date: dateVal, items: items }),
  }).then(function (r) { return r.json(); }).then(function (res) {
    if (res.error) { alert('fitl00p import failed: ' + res.error); return; }
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
