'use strict';

// IIFE-wrapped for the same reason as diabetes-engine.js: loaded as a
// plain browser <script> alongside app.js, top-level names here would
// otherwise leak into the shared global script scope.
(function () {

/* ═══════════════════════════════════════════════════════════
   fitl00p — Nightscout / tconnectsync adapter
   Pure Node/CommonJS. Maps Nightscout's standard REST API shapes
   (entries.json / treatments.json — the same format tconnectsync,
   xDrip, Loop, and AndroidAPS all upload into) onto the plain data
   model diabetes-engine.js expects. The engine itself never changes
   for this — it stays source-agnostic on purpose.

   Verified against a real live tconnectsync + Nightscout feed on
   2026-07-22 (100-treatment sample). Two things the initial version
   got wrong from documentation alone, corrected here:

   1. Basal isn't "profile schedule + occasional temp-basal overrides"
      the way MDI/older pump tooling assumes. Tandem's Control-IQ
      reports basal as a continuous stream of "Temp Basal" treatments
      roughly every 5 minutes, each carrying the ACTUAL delivered rate
      and duration for that segment (96 of them in one 100-treatment
      sample). That's directly summable into real delivered units —
      no need to reconstruct anything from profile.json.

   2. `notes` is not a food name. A real bolus came through as
      eventType "Combo Bolus" with notes "BLE Standard Bolus" — a
      description of the delivery mechanism, not what was eaten.
      Tandem pumps carry no food-name data at all, so mealName is left
      null for pump-sourced boluses rather than populated with a
      generic technical string that would make every meal look like
      the same recurring meal in Stage 5's per-meal analysis.

   3. (Added after a real Omnipod + Trio feed replaced the Tandem one
      on 2026-09-14.) Not every AID system bundles a meal's carbs and
      insulin into one record the way Tandem does. Trio logs them as
      two separate treatments — see pairCarbsWithInsulin below for how
      those get matched back into a single bolus.

   4. (Added after reviewing a live Trio feed on 2026-10-10.) Trio's
      SMB/Bolus correction records carry no `glucose` field at all —
      unlike a manual Tandem correction, which stamps the BG it was
      taken against directly on the treatment. See nearestGlucoseAt
      below for why that silently breaks every ISF calculation if left
      unfilled, not just leaves it unpersonalized.
   ═══════════════════════════════════════════════════════════ */

const MGDL_PER_MMOL = 18.0182;

function mgdlToMmol(mgdl) {
  return Math.round((Number(mgdl) / MGDL_PER_MMOL) * 100) / 100;
}

function toMs(t) {
  if (t == null) return null;
  if (typeof t === 'number') return t; // Nightscout's `date`/`mills` are already epoch ms
  const ms = new Date(t).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function treatmentMs(t) {
  return toMs(t.created_at ?? t.date ?? t.mills);
}

/* ── Glucose entries → glucoseHistory ─────────────────────────
   Nightscout stores sgv in mg/dL regardless of what the UI displays. */
function adaptEntries(entries) {
  return (entries || [])
    .filter(e => e && (e.type === 'sgv' || e.sgv != null) && Number(e.sgv) > 0)
    .map(e => ({
      time: toMs(e.date ?? e.mills ?? e.dateString),
      value: mgdlToMmol(e.sgv),
    }))
    .filter(r => r.time != null)
    .sort((a, b) => a.time - b.time);
}

/* ── Treatments → boluses / corrections / basalDoses ──────────
   eventType strings seen in practice: "Temp Basal" (continuous
   delivered-rate segments), "Combo Bolus" (used for BOTH meal and
   correction-only doses — carbs presence is what actually
   distinguishes them, not the label), "Basal Suspension" / "Basal
   Resume" (informational markers; the zero/adjusted rate they
   describe already shows up in the Temp Basal stream itself, so
   they're not needed for the units math and are safely ignored). */
function classifyTreatment(t) {
  const type = String(t.eventType || '').toLowerCase();
  const carbs = Number(t.carbs) || 0;
  const insulin = Number(t.insulin) || 0;

  if (type.includes('temp basal')) return 'basal';
  // Bundled record (Tandem-style Combo Bolus) — carbs presence is what
  // actually distinguishes a meal from a correction here, not the label.
  if (insulin > 0 && carbs > 0) return type.includes('correction') ? 'correction' : 'bolus';
  if (insulin > 0) return type.includes('meal') ? 'bolus' : 'correction'; // insulin with no carbs and no explicit label
  if (carbs > 0) return 'carbs-only'; // see pairCarbsWithInsulin below
  return 'other';
}

// Trio/Loop-style feeds log a meal as two SEPARATE treatment records — a
// carbs-only entry (commonly eventType "Carb Correction", despite the
// name; carbs given to treat/prevent a low use the exact same shape and
// are indistinguishable from a Trio feed alone) and a nearby insulin-only
// entry (a manual "Bolus", sometimes trailed by automated "SMB"
// micro-doses) — unlike Tandem, which bundles carbs+insulin into one
// "Combo Bolus" record. Confirmed against a real live Trio feed on
// 2026-09-17: every genuine meal's carb entry had a matching insulin
// entry within a few minutes; carb entries with nothing nearby were
// exactly the small hypo-treatment-shaped ones (8-25g, no bolus) you'd
// expect NOT to be paired with a dose.
//
// Pairs each carbs-only entry with the closest unclaimed insulin-only
// entry within CARB_PAIR_WINDOW_MS (ascending distance order, so a
// closely-spaced meal+snack won't both grab the same bolus). Only the
// immediate bolus is attached, not any trailing SMBs — the regimen-review
// functions only need units>0 to detect "a meal happened here"; they
// don't use the unit amount itself (the actual check is glucose
// trajectory over the following 4h), so imprecise dose attribution
// doesn't affect them, and SMBs stay in the corrections stream where
// diabetes-engine's existing carbInterference guard (now that carbs are
// correctly attached to a bolus at this timestamp) keeps them out of any
// ISF estimate. An unmatched carb entry is left unpaired rather than
// forced into a fake meal record.
const CARB_PAIR_WINDOW_MS = 25 * 60000;

function pairCarbsWithInsulin(treatments) {
  const carbOnly = [];
  const insulinOnly = [];
  for (const t of treatments || []) {
    const ms = treatmentMs(t);
    if (ms == null) continue;
    const carbs = Number(t.carbs) || 0;
    const insulin = Number(t.insulin) || 0;
    if (carbs > 0 && insulin <= 0) carbOnly.push({ t, ms, carbs });
    else if (insulin > 0 && carbs <= 0) insulinOnly.push({ t, ms, insulin });
  }
  carbOnly.sort((a, b) => a.ms - b.ms);

  const consumed = new Set();
  const pairs = [];
  for (const c of carbOnly) {
    let best = null;
    for (const i of insulinOnly) {
      if (consumed.has(i.t)) continue;
      const dist = Math.abs(i.ms - c.ms);
      if (dist > CARB_PAIR_WINDOW_MS) continue;
      if (!best || dist < Math.abs(best.ms - c.ms)) best = i;
    }
    if (best) {
      consumed.add(c.t);
      consumed.add(best.t);
      pairs.push({ time: c.ms, units: best.insulin, carbs: c.carbs, mealName: null });
    }
  }
  return { pairs, consumed };
}

// Trio's SMB/Bolus correction records carry no `glucose` field at all —
// unlike a manual Tandem correction, which stamps the BG it was taken
// against directly on the treatment. The reading still exists, just not
// attached: it's whatever entries.json shows for that same moment. Left
// unfilled, `startGlucose` stays null, and diabetes-engine's
// resolveCorrection coerces that through Number(null) -> 0 rather than
// NaN, which doesn't trip its Number.isFinite check — it quietly produces
// a large negative "dropPerUnit" instead of skipping the sample, and
// every one of these corrections then gets filtered out downstream by
// the plausibility bounds as if the data didn't exist. Backfilling from
// the nearest real CGM reading (within NEAREST_GLUCOSE_WINDOW_MS, since
// entries land roughly every 5min) is what a glucose field on the
// treatment itself would have said.
const NEAREST_GLUCOSE_WINDOW_MS = 7.5 * 60000;

function nearestGlucoseAt(glucoseHistory, ms) {
  let best = null, bestDiff = Infinity;
  for (const r of glucoseHistory || []) {
    const diff = Math.abs(r.time - ms);
    if (diff <= NEAREST_GLUCOSE_WINDOW_MS && diff < bestDiff) { best = r.value; bestDiff = diff; }
  }
  return best;
}

function adaptTreatments(treatments, glucoseHistory) {
  const boluses = [];
  const corrections = [];
  const basalDoses = [];

  const { pairs, consumed } = pairCarbsWithInsulin(treatments);
  boluses.push(...pairs);

  for (const t of treatments || []) {
    if (consumed.has(t)) continue;
    const ms = treatmentMs(t);
    if (ms == null) continue;
    const kind = classifyTreatment(t);
    const insulin = Number(t.insulin) || 0;
    const carbs = Number(t.carbs) || 0;

    if (kind === 'bolus') {
      boluses.push({ time: ms, units: insulin, carbs, mealName: t.foodType || null });
    } else if (kind === 'correction') {
      let startGlucose = null;
      if (t.glucose != null) {
        startGlucose = t.units === 'mmol' ? Number(t.glucose) : mgdlToMmol(t.glucose);
      } else {
        startGlucose = nearestGlucoseAt(glucoseHistory, ms);
      }
      corrections.push({ time: ms, units: insulin, startGlucose, predictedGlucose: null });
    } else if (kind === 'basal') {
      const durationMin = Number(t.duration) || 0;
      const rate = t.rate != null ? Number(t.rate) : (t.absolute != null ? Number(t.absolute) : null);
      if (durationMin > 0 && rate != null) {
        basalDoses.push({
          time: ms,
          units: Math.round(rate * (durationMin / 60) * 1000) / 1000,
          durationMin,
          rate: Math.round(rate * 1000) / 1000,
        });
      }
    }
    // kind === 'carbs-only' (unmatched) or 'other': ignored — a carb
    // entry nothing could be paired with is treated as a genuine
    // hypo-treatment, not forced into a fake meal or correction.
  }

  boluses.sort((a, b) => a.time - b.time);
  return { boluses, corrections, basalDoses };
}

/* ── Top-level adapter ─────────────────────────────────────── */
function adaptNightscoutData({ entries, treatments } = {}) {
  const glucoseHistory = adaptEntries(entries);
  const { boluses, corrections, basalDoses } = adaptTreatments(treatments, glucoseHistory);
  return { glucoseHistory, boluses, corrections, basalDoses };
}

const NightscoutAdapter = {
  mgdlToMmol,
  adaptEntries,
  adaptTreatments,
  adaptNightscoutData,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = NightscoutAdapter;
} else if (typeof window !== 'undefined') {
  window.NightscoutAdapter = NightscoutAdapter;
}

})();
