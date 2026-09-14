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
  if (insulin > 0 || carbs > 0) {
    if (type.includes('correction')) return 'correction';
    if (type.includes('meal') || carbs > 0) return 'bolus';
    return 'correction'; // insulin with no carbs and no explicit label
  }
  return 'other';
}

function adaptTreatments(treatments) {
  const boluses = [];
  const corrections = [];
  const basalDoses = [];

  for (const t of treatments || []) {
    const ms = toMs(t.created_at ?? t.date ?? t.mills);
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
  }

  return { boluses, corrections, basalDoses };
}

/* ── Profile history → profile-switch timeline ────────────────
   Nightscout doesn't log a distinct "Profile Switch" treatment event for
   a Tandem/tconnectsync feed — instead, a fresh profile.json document
   gets uploaded each time the pump's active default profile actually
   changes, timestamped by when that happened. Fetching more than the
   latest one (see diabetes-sync.js) and sorting them gives a real
   timeline of which named profile (e.g. a weekday-default vs a
   deliberately-switched-to alternate) was active at any point in the
   lookback window — exactly what's needed to review basal/ISF/carb-ratio
   suggestions separately per profile instead of pooling every day
   together regardless of which settings were actually running. */
function adaptProfileSwitches(profileDocs) {
  if (!Array.isArray(profileDocs)) return [];
  return profileDocs
    .map(d => ({ ms: toMs(d.created_at ?? d.startDate ?? d.mills), profileName: d.defaultProfile || null }))
    .filter(s => s.ms != null && s.profileName)
    .sort((a, b) => a.ms - b.ms);
}

/* ── Top-level adapter ─────────────────────────────────────── */
function adaptNightscoutData({ entries, treatments } = {}) {
  const glucoseHistory = adaptEntries(entries);
  const { boluses, corrections, basalDoses } = adaptTreatments(treatments);
  return { glucoseHistory, boluses, corrections, basalDoses };
}

const NightscoutAdapter = {
  mgdlToMmol,
  adaptEntries,
  adaptTreatments,
  adaptProfileSwitches,
  adaptNightscoutData,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = NightscoutAdapter;
} else if (typeof window !== 'undefined') {
  window.NightscoutAdapter = NightscoutAdapter;
}

})();
