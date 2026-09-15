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

import NightscoutAdapter from './nightscout-adapter.ts';

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

async function fetchNightscoutInput(profile: any) {
  const baseUrl = (profile.diabetes_ns_url || '').replace(/\/+$/, '');
  if (!baseUrl) return null;
  const sinceMs = Date.now() - NS_LOOKBACK_DAYS * 24 * 60 * 60000;
  const reqHeaders: Record<string, string> = {};
  if (profile.diabetes_ns_secret) reqHeaders['API-SECRET'] = await sha1Hex(profile.diabetes_ns_secret);
  const tokenQS = profile.diabetes_ns_token ? `&token=${encodeURIComponent(profile.diabetes_ns_token)}` : '';

  const [entries, treatments] = await Promise.all([
    nsFetch(`${baseUrl}/api/v1/entries.json?count=20000&find[date][$gte]=${sinceMs}${tokenQS}`, reqHeaders),
    nsFetch(`${baseUrl}/api/v1/treatments.json?count=5000&find[created_at][$gte]=${new Date(sinceMs).toISOString()}${tokenQS}`, reqHeaders),
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

  return { ...adapted, settings, activities: {} };
}

export { fetchNightscoutInput, nsFetch, sha1Hex };
