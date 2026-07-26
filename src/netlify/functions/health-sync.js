// netlify/functions/health-sync.js
// Receives Apple Health data from Health Auto Export app.
// Auth: Bearer <api_key> header.
// Payload format: https://github.com/Lybron/health-auto-export/wiki/API-Export---JSON-Format
//
// FIX (2026-06-30): Active/Resting/Dietary Energy were being OVERWRITTEN by
// the last sample processed instead of summed. Confirmed via raw_payload
// diagnostic capture that Health Auto Export sends individual samples per
// metric — e.g. dietary_energy arrives as one entry per MyFitnessPal meal
// log (sampleCount: 32 for one day), and active/basal energy arrive as
// per-minute Apple Watch readings (sampleCount: 6000-9000+ for one day).
// These now accumulate across all samples for a given log_date, the same
// way step_count already did. The diagnostic raw_payload capture has been
// removed now that the root cause is confirmed and fixed.

const crypto = require('crypto');

const SB_URL     = process.env.SUPABASE_URL;
const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'POST only' }) };
  }

  // ── 1. Authenticate ───────────────────────────────────────
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (!token) {
    return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Missing Authorization header' }) };
  }

  if (!SB_URL || !SB_SERVICE) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Server not configured' }) };
  }

  const keyHash = crypto.createHash('sha256').update(token).digest('hex');
  const keyRes  = await sbFetch(`/rest/v1/health_api_keys?key_hash=eq.${keyHash}&select=user_id,id`);

  if (!keyRes.ok || !keyRes.data?.length) {
    return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Invalid API key' }) };
  }

  const { user_id, id: keyId } = keyRes.data[0];

  // Update last_used (fire and forget)
  sbFetch(`/rest/v1/health_api_keys?id=eq.${keyId}`, 'PATCH', { last_used: new Date().toISOString() });

  // ── 2. Parse body ─────────────────────────────────────────
  let body;
  try {
    const raw = event.body || '';
    body = JSON.parse(raw);
  } catch (e) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON: ' + e.message }) };
  }

  // Health Auto Export format: { data: { metrics: [...], workouts: [...] } }
  const metrics  = body?.data?.metrics  || [];
  const workouts = body?.data?.workouts || [];

  if (!metrics.length && !workouts.length) {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ received: 0, processed: 0, message: 'No metrics or workouts in payload' }) };
  }

  // ── Discrete workout events ────────────────────────────────
  // Separate from the daily-aggregate loop below — these carry their own
  // real start/end times (the daily metrics above never do), which is
  // exactly what the diabetes engine's post-exercise window logic needs
  // and previously never had, despite this array always being present
  // in the payload whenever Health Auto Export's "Workouts" export type
  // is turned on. Dedup on (user_id, external_id): Health Auto Export
  // re-sends a rolling window of past workouts on every automated sync,
  // not just new ones since last time.
  let workoutsProcessed = 0;
  for (const w of workouts) {
    const start = w.start, end = w.end;
    if (!start || !end) continue;
    const externalId = w.id ? String(w.id) : `${w.name || 'workout'}_${start}`;
    const row = {
      user_id,
      external_id: externalId,
      workout_type: w.name || 'Workout',
      started_at: new Date(start).toISOString(),
      ended_at: new Date(end).toISOString(),
      duration_min: w.duration != null ? round1(Number(w.duration) / 60) : null,
      active_energy_kcal: qtyToKcal(w.activeEnergyBurned),
      total_energy_kcal: qtyToKcal(w.totalEnergy),
      distance_km: qtyToKm(w.distance),
      avg_heart_rate: w.avgHeartRate?.qty != null ? round1(Number(w.avgHeartRate.qty)) : null,
      max_heart_rate: w.maxHeartRate?.qty != null ? round1(Number(w.maxHeartRate.qty)) : null,
      synced_at: new Date().toISOString(),
    };
    const res = await sbFetch(
      '/rest/v1/apple_health_workouts?on_conflict=user_id,external_id',
      'POST', row,
      { 'Prefer': 'resolution=merge-duplicates,return=minimal' }
    );
    if (res.ok) workoutsProcessed++;
  }

  if (!metrics.length) {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ received: 0, processed: 0, workoutsProcessed, message: 'No metrics in payload' }) };
  }

  // ── 3. Group all metric data points by date ───────────────
  const byDate = {};

  for (const metric of metrics) {
    const metricName  = (metric.name  || '').toLowerCase().replace(/\s+/g, '_');
    const metricUnits = (metric.units || '').toLowerCase();
    const dataPoints  = metric.data   || [];

    for (const item of dataPoints) {
      // Date field: "2024-01-15 08:30:00 +0000" — take first 10 chars
      const rawDate = item.date || '';
      const logDate = rawDate.substring(0, 10);
      if (!logDate || logDate.length < 10 || !logDate.match(/^\d{4}-\d{2}-\d{2}$/)) continue;

      if (!byDate[logDate]) byDate[logDate] = {};
      const d = byDate[logDate];

      // ── Sleep Analysis ──────────────────────────────────
      // Fields: asleep, inBed, sleepStart, sleepEnd
      // With summarise ON and phases enabled: deep, core, rem, awake fields appear
      if (metricName.includes('sleep')) {
        // Sleep phases (present when "Include Sleep Phases" enabled in app)
        if (item.deep     != null) d.sleep_deep_hrs  = round2(item.deep);
        if (item.rem      != null) d.sleep_rem_hrs   = round2(item.rem);
        if (item.core     != null) d.sleep_core_hrs  = round2(item.core);

        // Total sleep — prefer the "asleep" field when present, but it has
        // been observed to be missing/zero from Health Auto Export even
        // when phase data (deep/rem/core) arrives correctly in the same
        // payload. Deep + REM + Core is the same quantity "asleep" would
        // represent (total time actually asleep, excluding awake periods),
        // so derive it from the phases as a fallback rather than leaving
        // total sleep at 0 whenever the top-level field doesn't show up.
        if (item.asleep != null && item.asleep > 0) {
          d.sleep_total_hrs = round2(item.asleep);
        } else if (item.deep != null || item.rem != null || item.core != null) {
          d.sleep_total_hrs = round2((item.deep || 0) + (item.rem || 0) + (item.core || 0));
        }
        // Times
        if (item.sleepStart) d.sleep_start = item.sleepStart;
        if (item.sleepEnd)   d.sleep_end   = item.sleepEnd;
      }

      // ── Resting Heart Rate ──────────────────────────────
      // Name: "Resting Heart Rate", fields: qty (bpm)
      if (metricName.includes('resting_heart_rate')) {
        if (item.qty != null) d.resting_hr = round1(item.qty);
      }

      // ── HRV (Heart Rate Variability SDNN) ───────────────
      // Name: "Heart Rate Variability", fields: qty or Avg (ms)
      if (metricName.includes('heart_rate_variability')) {
        const val = item.Avg ?? item.avg ?? item.qty;
        if (val != null) d.hrv_ms = round2(val);
      }

      // ── Step Count ──────────────────────────────────────
      // Name: "Step Count", fields: qty (count)
      if (metricName === 'step_count' || metricName === 'steps') {
        const steps = parseInt(item.qty);
        if (!isNaN(steps)) d.steps = (d.steps || 0) + steps;
      }

      // ── Walking + Running Distance ───────────────────────
      // Name: "Walking + Running Distance", fields: qty (km)
      // Same per-window sample pattern as Step Count — sums across all
      // samples for the date rather than taking the last one seen.
      if (metricName.includes('walking_running_distance')) {
        const val = item.qty;
        if (val != null) d.distance_km = round2((d.distance_km || 0) + Number(val));
      }

      // ── Energy unit converter ─────────────────────────────
      // Health Auto Export can send energy in kcal, kJ, or MJ depending on
      // the device locale and app settings. Convert all to kcal.
      // Note: deliberately NOT rounded here — rounding is applied once,
      // after summation, in the accumulator lines below. Rounding every
      // individual sample before summing thousands of them would compound
      // rounding error into a meaningfully wrong daily total.
      const toKcal = (val, units) => {
        if (units.includes('mj'))              return val * 238.846; // megajoules
        if (units.includes('kj'))              return val / 4.184;   // kilojoules
        if (units.includes('cal') && !units.includes('kcal')) return val / 1000; // cal → kcal
        return val; // already kcal
      };

      // ── Active Energy Burned ─────────────────────────────
      // Health Auto Export sends one sample per minute of Apple Watch
      // activity (commonly several thousand samples/day). Sum across all
      // samples for the date, same pattern as Step Count above.
      if (metricName.includes('active_energy')) {
        const val = item.qty;
        if (val != null) d.active_energy_kcal = (d.active_energy_kcal || 0) + toKcal(val, metricUnits);
      }

      // ── Resting Energy (Basal Metabolic Rate lived) ───────
      // Same per-minute sample pattern as Active Energy above.
      if (metricName.includes('resting_energy') || metricName === 'basal_energy_burned') {
        const val = item.qty ?? item.Avg ?? item.avg;
        if (val != null) d.resting_energy_kcal = (d.resting_energy_kcal || 0) + toKcal(val, metricUnits);
      }

      // ── Dietary Energy ───────────────────────────────────
      // Health Auto Export sends one sample per logged meal/entry (e.g. one
      // per MyFitnessPal food log), not a daily total. Sum across all
      // entries for the date to get the true daily intake.
      //
      // TEMP DIAGNOSTIC (investigating fitl00p > MFP mismatch): capture the
      // raw sample list into the otherwise-unused raw_payload column so we
      // can inspect exact qty/timestamps per sample and check for
      // duplicate/overlapping HealthKit writes. Remove once diagnosed.
      if (metricName.includes('dietary_energy')) {
        const val = item.qty ?? item.Avg ?? item.avg;
        if (val != null) {
          d.dietary_energy_kcal = (d.dietary_energy_kcal || 0) + toKcal(val, metricUnits);
          if (!d._dietarySamples) d._dietarySamples = [];
          d._dietarySamples.push({ date: item.date, qty: val, units: metricUnits, kcal: toKcal(val, metricUnits) });
        }
      }

      // ── Body Weight ─────────────────────────────────────
      // Name: "Body Weight" or "Weight", units: kg or lb
      if (metricName.includes('weight')) { // matches weight_body_mass, body_weight, weight
        const val = item.qty;
        if (val != null) {
          const kg = metricUnits.includes('lb') ? round2(val * 0.453592) : round2(val);
          d.weight_kg = kg;
        }
      }

      // ── Body Fat Percentage ─────────────────────────────
      if (metricName.includes('body_fat')) {
        if (item.qty != null) d.body_fat_pct = round2(item.qty);
      }

      // ── Body Mass Index ─────────────────────────────────
      if (metricName.includes('body_mass_index') || metricName === 'bmi') {
        if (item.qty != null) d.bmi = round2(item.qty);
      }

      // ── Blood Glucose ────────────────────────────────────
      // Name: "Blood Glucose", fields: qty (mmol/L or mg/dL)
      if (metricName.includes('blood_glucose')) {
        const val = item.qty;
        if (val != null) {
          const mmol = metricUnits.includes('mg') ? round2(val / 18.0182) : round2(val);
          if (!d._glucose) d._glucose = [];
          d._glucose.push(mmol);
        }
      }

      // ── Blood Oxygen (SpO2) ─────────────────────────────
      // Name: "Blood Oxygen Saturation" or "Oxygen Saturation"
      if (metricName.includes('oxygen_saturation') || metricName.includes('blood_oxygen')) {
        const val = item.qty ?? item.Avg ?? item.avg;
        const minVal = item.Min ?? item.min;
        if (val != null) {
          if (!d._spo2) d._spo2 = [];
          d._spo2.push(Number(val));
        }
        if (minVal != null) {
          d.spo2_min = Math.min(d.spo2_min ?? 100, Number(minVal));
        }
      }

      // ── Respiratory Rate ─────────────────────────────────
      // Name: "Respiratory Rate", fields: qty or Avg (breaths/min)
      if (metricName.includes('respiratory_rate')) {
        const val = item.Avg ?? item.avg ?? item.qty;
        if (val != null) d.respiratory_rate = round1(val);
      }

      // ── Wrist Temperature (deviation from baseline) ──────
      // Name: "Apple Sleeping Wrist Temperature", fields: qty (°C deviation)
      if (metricName.includes('wrist_temperature') || metricName.includes('sleeping_wrist')) {
        const val = item.qty;
        if (val != null) d.wrist_temp_dev = round2(val);
      }

      // ── VO2 Max ──────────────────────────────────────────
      // Name: "VO2 Max", fields: qty (mL/kg/min)
      if (metricName.includes('vo2_max') || metricName === 'vo2max') {
        const val = item.qty;
        if (val != null) d.vo2_max = round1(val);
      }

      // ── Exercise Minutes ─────────────────────────────────
      // Name: "Apple Exercise Time" or "Exercise Time"
      // Sums across all samples for the date, same pattern as Step Count —
      // this metric arrives as multiple per-window samples throughout the
      // day via the automated sync, not one daily total.
      if (metricName.includes('exercise_time') || metricName.includes('exercise_minutes')) {
        const val = item.qty;
        if (val != null) d.exercise_mins = Math.round((d.exercise_mins || 0) + Number(val));
      }

      // ── Heart Rate (workout average + whole-day average) ──
      // Name: "Heart Rate". The automated sync sends many per-window
      // samples across the day, each with its own Avg — not one daily
      // summary — so a whole-day average must be aggregated from all
      // samples' Avg values rather than overwritten by the last one seen.
      if (metricName === 'heart_rate') {
        const val = item.Avg ?? item.avg;
        if (val != null) {
          d.workout_hr_avg = round1(val);
          if (!d._hrSamples) d._hrSamples = [];
          d._hrSamples.push(Number(val));
        }
      }
    }
  }

  // ── 4. Upsert each date row ───────────────────────────────
  const processed = [];
  const errors    = [];

  for (const [logDate, d] of Object.entries(byDate)) {
    // Round energy totals once, after full-precision summation
    if (d.active_energy_kcal  != null) d.active_energy_kcal  = round1(d.active_energy_kcal);
    if (d.resting_energy_kcal != null) d.resting_energy_kcal = round1(d.resting_energy_kcal);
    if (d.dietary_energy_kcal != null) d.dietary_energy_kcal = round1(d.dietary_energy_kcal);

    // Aggregate glucose
    if (d._glucose?.length) {
      d.glucose_avg_mmol = round2(d._glucose.reduce((a,b) => a+b, 0) / d._glucose.length);
      d.glucose_min_mmol = round2(Math.min(...d._glucose));
      d.glucose_max_mmol = round2(Math.max(...d._glucose));
      delete d._glucose;
    }

    // Aggregate SpO2
    if (d._spo2?.length) {
      d.spo2_avg = round1(d._spo2.reduce((a,b) => a+b, 0) / d._spo2.length);
      if (!d.spo2_min) d.spo2_min = round1(Math.min(...d._spo2));
      delete d._spo2;
    }

    // Aggregate whole-day average heart rate
    if (d._hrSamples?.length) {
      d.heart_rate_avg = round1(d._hrSamples.reduce((a,b) => a+b, 0) / d._hrSamples.length);
      delete d._hrSamples;
    }

    // TEMP DIAGNOSTIC — see comment above, in the Dietary Energy block.
    let dietarySamples = null;
    if (d._dietarySamples) {
      dietarySamples = d._dietarySamples;
      delete d._dietarySamples;
    }

    const row = {
      user_id,
      log_date: logDate,
      ...d,
      readiness_score: computeReadiness(d),
      synced_at: new Date().toISOString(), // always update so dashboard shows correct last-sync time
      ...(dietarySamples ? { raw_payload: { dietary_energy_samples: dietarySamples } } : {}),
    };

    const res = await sbFetch(
      '/rest/v1/health_daily?on_conflict=user_id,log_date',
      'POST',
      row,
      { 'Prefer': 'resolution=merge-duplicates,return=minimal' }
    );

    if (res.ok) {
      processed.push(logDate);

      // ── Back-fill into daily_logs ─────────────────────
      const logUpdate = { user_id, log_date: logDate };
      let hasUpdate = false;

      if (row.steps != null) {
        logUpdate.steps = row.steps;
        hasUpdate = true;
      }

      if (row.weight_kg != null) {
        logUpdate.weight = row.weight_kg;
        hasUpdate = true;
      }

      // Fix: use != null not falsy check — 0 kcal is valid
      if (row.dietary_energy_kcal != null) {
        logUpdate.cal_apple = row.dietary_energy_kcal;
        hasUpdate = true;
      }

      if (hasUpdate) {
        sbFetch(
          '/rest/v1/daily_logs?on_conflict=user_id,log_date',
          'POST',
          logUpdate,
          { 'Prefer': 'resolution=merge-duplicates,return=minimal' }
        );
      }
    } else {
      errors.push({ date: logDate, error: res.error });
      console.error('Upsert error for', logDate, res.error);
    }
  }

  // Collect unit info for debugging
  const unitsSeen = {};
  for (const metric of metrics) {
    const name  = (metric.name  || '').toLowerCase().replace(/\s+/g, '_');
    const units = (metric.units || '').toLowerCase();
    if (name.includes('energy')) unitsSeen[name] = units;
  }

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      received:  Object.keys(byDate).length,
      processed: processed.length,
      workoutsReceived: workouts.length,
      workoutsProcessed,
      errors:    errors.length,
      dates:     processed,
      unitsSeen, // shows what unit strings Health Auto Export sent
      ...(errors.length ? { errorDetails: errors } : {}),
    }),
  };
};

// ── Readiness score (0–100) ───────────────────────────────
function computeReadiness(d) {
  let score = 100, factors = 0;
  if (d.sleep_total_hrs != null) {
    const s = d.sleep_total_hrs;
    const ss = s >= 7 && s <= 9 ? 100 : s >= 6 ? 75 : s >= 5 ? 50 : s > 9 ? 85 : 25;
    score = score * 0.6 + ss * 0.4; factors++;
  }
  if (d.hrv_ms != null) {
    const h = d.hrv_ms;
    const hs = h >= 80 ? 100 : h >= 60 ? 85 : h >= 40 ? 70 : h >= 20 ? 50 : 30;
    score = score * 0.7 + hs * 0.3; factors++;
  }
  if (d.resting_hr != null) {
    const r = d.resting_hr;
    const rs = r < 55 ? 100 : r < 65 ? 85 : r < 75 ? 70 : r < 85 ? 50 : 30;
    score = score * 0.8 + rs * 0.2; factors++;
  }
  return factors > 0 ? Math.round(Math.max(0, Math.min(100, score))) : null;
}

// ── Helpers ───────────────────────────────────────────────
const round1 = n => n == null ? null : Math.round(Number(n) * 10)   / 10;
const round2 = n => n == null ? null : Math.round(Number(n) * 100)  / 100;

// Workout fields arrive as { qty, units } rather than the metrics loop's
// separate qty/units pair — same conversions, different shape, so kept as
// their own small helpers rather than reshaping data to fit the other one.
function qtyToKcal(field) {
  if (field?.qty == null) return null;
  const val = Number(field.qty);
  const units = (field.units || '').toLowerCase();
  if (units.includes('mj')) return round1(val * 238.846);
  if (units.includes('kj')) return round1(val / 4.184);
  if (units.includes('cal') && !units.includes('kcal')) return round1(val / 1000);
  return round1(val);
}
function qtyToKm(field) {
  if (field?.qty == null) return null;
  const val = Number(field.qty);
  const units = (field.units || '').toLowerCase();
  return round2(units.includes('mi') ? val * 1.60934 : val);
}

async function sbFetch(path, method = 'GET', body = null, extra = {}) {
  try {
    const res = await fetch(`${SB_URL}${path}`, {
      method,
      headers: {
        'Content-Type':  'application/json',
        'apikey':        SB_SERVICE,
        'Authorization': `Bearer ${SB_SERVICE}`,
        ...extra,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    // 204 = success with no content (upsert with return=minimal)
    if (res.status === 204) return { ok: true, status: 204, data: null, error: null };
    const data  = res.ok  ? await res.json().catch(() => null) : null;
    const error = !res.ok ? await res.text().catch(() => '')   : null;
    return { ok: res.ok, status: res.status, data, error };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err.message };
  }
}
