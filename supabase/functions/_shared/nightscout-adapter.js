// GENERATED from src/nightscout-adapter.js by scripts/sync-shared.mjs — edit that file, not this one.
'use strict';

// IIFE-wrapped for the same reason as diabetes-engine.js: loaded as a
// plain browser <script> alongside app.js, top-level names here would
// otherwise leak into the shared global script scope.
const NightscoutAdapterNS = (function () {

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

   Re-checked 2026-10-24 (400 treatments): Control-IQ AUTOMATIC boluses
   arrive as eventType "Combo Bolus" with notes "Automatic Bolus" (carbs
   null, enteredBy "Pump (tconnectsync)", no separate flag field). They
   are insulin the pump gave on its own, not a correction the person
   chose, so they go into boluses as { auto: true, carbs: 0 } — counted
   in IOB and in every episode's insulin, never learned from as a manual
   correction or flagged by stacking caution. Manual no-carb boluses come
   through as "BLE Standard Bolus", "BLE Standard Bolus (Override)" or
   "Standard Bolus" and stay corrections. "Extended Bolus" (no carbs) is the
   delayed part of an extended meal bolus: insulin { extended: true, carbs:
   0 }, never a correction episode.

   The same Nightscout also holds two Trio (iOS loop, different pump) stints
   (2026-09-14..17, 10-07..10): automatic doses are eventType "SMB" (auto,
   as above), manual ones "Bolus", and food is a separate "Carb Correction"
   carrying the carbs (a meal entry, not a correction).

   Site changes: eventType "Site Change", logged by Tandem as two events a
   minute apart — "Cartridge Filled (120u filled)" then "Cannula Filled
   (0.3u primed)". The cannula fill is the new infusion site; a cartridge
   fill on its own (refill, same site) isn't a site change. Events within
   an hour of each other collapse into one.
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
// Tandem/tconnectsync: notes "Automatic Bolus". Trio / AndroidAPS / Loop
// super-micro-boluses: eventType "SMB" (or isSMB / automatic flags).
function isAutomaticBolus(t) {
  return /automatic bolus/i.test(String(t.notes || '')) || /^smb$/i.test(String(t.eventType || '').trim())
    || t.isSMB === true || t.automatic === true;
}

function classifyTreatment(t) {
  const type = String(t.eventType || '').toLowerCase();
  const carbs = Number(t.carbs) || 0;
  const insulin = Number(t.insulin) || 0;

  if (type.includes('temp basal')) return 'basal';
  if (type.includes('site change')) return 'site';
  if (insulin > 0 && carbs <= 0 && isAutomaticBolus(t)) return 'auto';
  // the delayed part of a Tandem extended (meal) bolus — insulin, not a correction
  if (insulin > 0 && carbs <= 0 && /extended bolus/i.test(String(t.notes || ''))) return 'extended';
  if (insulin > 0 || carbs > 0) {
    // carbs first: Trio logs food as eventType "Carb Correction"
    if (carbs > 0) return 'bolus';
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
  const siteEvents = [];

  for (const t of treatments || []) {
    const ms = toMs(t.created_at ?? t.date ?? t.mills);
    if (ms == null) continue;
    const kind = classifyTreatment(t);
    const insulin = Number(t.insulin) || 0;
    const carbs = Number(t.carbs) || 0;

    if (kind === 'auto') {
      boluses.push({ time: ms, units: insulin, carbs: 0, mealName: null, auto: true });
    } else if (kind === 'extended') {
      boluses.push({ time: ms, units: insulin, carbs: 0, mealName: null, extended: true });
    } else if (kind === 'site') {
      const notes = String(t.notes || t.reason || '');
      // cartridge / tubing fill alone = refill on the same site
      if (/cannula/i.test(notes) || !/cartridge|tubing/i.test(notes)) siteEvents.push(ms);
    } else if (kind === 'bolus') {
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

  siteEvents.sort((a, b) => a - b);
  const siteChanges = [];
  for (const ms of siteEvents) {
    const last = siteChanges[siteChanges.length - 1];
    if (last && ms - last.time <= SITE_CHANGE_MERGE_MS) last.time = ms;
    else siteChanges.push({ time: ms });
  }

  return { boluses, corrections, basalDoses, siteChanges };
}
const SITE_CHANGE_MERGE_MS = 60 * 60000;

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
  const { boluses, corrections, basalDoses, siteChanges } = adaptTreatments(treatments);
  return { glucoseHistory, boluses, corrections, basalDoses, siteChanges };
}

const NightscoutAdapter = {
  mgdlToMmol,
  adaptEntries,
  adaptTreatments,
  adaptProfileSwitches,
  adaptNightscoutData,
};

return NightscoutAdapter;

})();

export default NightscoutAdapterNS;
