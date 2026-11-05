// Shared "pull this profile's Nightscout data and adapt it" helper —
// used by both notify-glucose-forecast (every 15 min) and notify-ai-coach
// (once a day). Split out into _shared rather than one function
// importing the other's index.ts: each Supabase Edge Function's
// index.ts calls Deno.serve(...) at module top level, so importing one
// function's index.ts from another would register a second, unwanted
// HTTP handler as a side effect of the import — the Netlify originals
// could get away with `require('./notify-glucose-forecast')` because
// requiring a CommonJS module never auto-invokes anything, only Deno's
// module-level Deno.serve() does.
//
// Ported from the fetchNightscoutInput/nsFetch functions in
// src/netlify/functions/notify-glucose-forecast.js and
// src/netlify/functions/notify-ai-coach.js (identical in both) — logic
// unchanged; Node's crypto.createHash replaced with Web Crypto's
// crypto.subtle.digest for the SHA1 hash, same as diabetes-sync's port.

import NightscoutAdapter from './nightscout-adapter.js';

async function sha1Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function nsFetch(url: string, headers: Record<string, string>) {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return { ok: false, data: null as any };
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, data: null as any };
  }
}

const NS_LOOKBACK_DAYS = 14; // matches fetchDiabetesData()'s live default
// Per-day ceilings for the count= params: 288 CGM readings a day, and
// Control-IQ logs a Temp Basal roughly every 5 min plus boluses/alarms
// (~370/day on a real tconnectsync feed) — the old fixed 20000/5000
// silently truncated treatments much past 2 weeks.
const NS_ENTRIES_PER_DAY = 320;
const NS_TREATMENTS_PER_DAY = 500;

// days: lookback (default 14). untilMs (optional): fetch only up to this
// instant — diabetes-learn backfills history in chunks [untilMs - days, untilMs].
async function fetchNightscoutInput(profile: any, { days = NS_LOOKBACK_DAYS, untilMs = null }: { days?: number; untilMs?: number | null } = {}) {
  const baseUrl = (profile.diabetes_ns_url || '').replace(/\/+$/, '');
  if (!baseUrl) return null;
  const endMs = untilMs ?? Date.now();
  const sinceMs = endMs - days * 24 * 60 * 60000;
  const untilE = untilMs != null ? `&find[date][$lte]=${untilMs}` : '';
  const untilT = untilMs != null ? `&find[created_at][$lte]=${new Date(untilMs).toISOString()}` : '';
  const entriesCount = Math.max(20000, Math.ceil(days * NS_ENTRIES_PER_DAY));
  const treatmentsCount = Math.max(5000, Math.ceil(days * NS_TREATMENTS_PER_DAY));
  const reqHeaders: Record<string, string> = {};
  if (profile.diabetes_ns_secret) reqHeaders['API-SECRET'] = await sha1Hex(profile.diabetes_ns_secret);
  const tokenQS = profile.diabetes_ns_token ? `&token=${encodeURIComponent(profile.diabetes_ns_token)}` : '';

  const [entries, treatments] = await Promise.all([
    nsFetch(`${baseUrl}/api/v1/entries.json?count=${entriesCount}&find[date][$gte]=${sinceMs}${untilE}${tokenQS}`, reqHeaders),
    nsFetch(`${baseUrl}/api/v1/treatments.json?count=${treatmentsCount}&find[created_at][$gte]=${new Date(sinceMs).toISOString()}${untilT}${tokenQS}`, reqHeaders),
  ]);
  if (!entries.ok) return null;

  const adapted = NightscoutAdapter.adaptNightscoutData({
    entries: entries.data || [],
    treatments: treatments.ok ? (treatments.data || []) : [],
  });

  const settings = {
    targetLow: Number(profile.diabetes_target_low) || 3.9,
    targetHigh: Number(profile.diabetes_target_high) || 9.9,
    idealTarget: Number(profile.diabetes_ideal_target) || 6.1,
    carbRatio: Number(profile.diabetes_carb_ratio) || null,
    correctionFactor: Number(profile.diabetes_correction_factor) || null,
    insulinPeakMinutes: Number(profile.diabetes_insulin_peak_min) || 75,
    insulinDurationMinutes: Number(profile.diabetes_insulin_duration_min) || 240,
  };

  // fetchInfo: what came back — diabetes-learn won't score episodes from a
  // fetch that lost its treatments (insulin would look absent) or hit a
  // count= ceiling (the oldest days would be missing doses).
  const nE = (entries.data || []).length, nT = treatments.ok ? (treatments.data || []).length : 0;
  const fetchInfo = { days, treatmentsOk: treatments.ok, entries: nE, treatments: nT,
    truncated: nE >= entriesCount || nT >= treatmentsCount };

  return { ...adapted, settings, activities: {}, fetchInfo };
}

export { fetchNightscoutInput, nsFetch, sha1Hex };
