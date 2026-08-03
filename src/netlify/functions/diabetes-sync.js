// netlify/functions/diabetes-sync.js
// On-demand proxy: fetches glucose/treatment data from a Nightscout
// instance (fed by tconnectsync + a Dexcom Share bridge, or any other
// Nightscout-compatible uploader) and returns it already shaped for
// diabetes-engine.js. No database writes — same pull-through pattern as
// exercise-media.js, so no new Supabase tables are needed for this to work.
//
// Query params:
//   url      (required) Nightscout base URL, e.g. https://my-ns.example.com
//   days     (optional) how many days of history to pull, default 14
//   token    (optional) Nightscout access token, sent as ?token=
//   secret   (optional) raw Nightscout API secret — hashed here (Nightscout
//            requires SHA1 of the secret, never the raw value) and sent as
//            the API-SECRET header
//
// Verified against a real live tconnectsync + Nightscout feed — see
// nightscout-adapter.js for what that confirmed and corrected.

const crypto = require('crypto');
const { adaptNightscoutData } = require('../../nightscout-adapter.js');

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS };

  const qs = event.queryStringParameters || {};
  const baseUrl = (qs.url || '').replace(/\/+$/, '');
  if (!baseUrl) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing url parameter — your Nightscout base URL' }) };
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(baseUrl);
    if (parsedUrl.protocol !== 'https:') throw new Error('must be https');
  } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'url must be a valid https:// address' }) };
  }

  const days = Math.min(31, Math.max(1, parseInt(qs.days, 10) || 14));
  const sinceMs = Date.now() - days * 24 * 60 * 60000;

  const reqHeaders = {};
  if (qs.secret) reqHeaders['API-SECRET'] = crypto.createHash('sha1').update(qs.secret).digest('hex');
  const tokenQS = qs.token ? `&token=${encodeURIComponent(qs.token)}` : '';

  try {
    const [entries, treatments, profileDocs] = await Promise.all([
      nsFetch(`${baseUrl}/api/v1/entries.json?count=20000&find[date][$gte]=${sinceMs}${tokenQS}`, reqHeaders),
      nsFetch(`${baseUrl}/api/v1/treatments.json?count=5000&find[created_at][$gte]=${new Date(sinceMs).toISOString()}${tokenQS}`, reqHeaders),
      nsFetch(`${baseUrl}/api/v1/profile.json?count=1${tokenQS}`, reqHeaders),
    ]);

    if (!entries.ok) {
      return { statusCode: entries.status || 502, headers: HEADERS, body: JSON.stringify({ error: `Nightscout entries fetch failed: ${entries.error}` }) };
    }

    const adapted = adaptNightscoutData({
      entries: entries.data || [],
      treatments: treatments.ok ? (treatments.data || []) : [],
    });

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        ...adapted,
        // Control-IQ only logs a Temp Basal treatment when it actually
        // overrides the scheduled rate — a stretch where it just holds the
        // profile default (or tconnectsync misses a poll) leaves a real
        // hole in Nightscout's own data, not a fitl00p sync-lag artifact.
        // The chart uses this to fill those holes with the *scheduled*
        // rate, visually distinct from a confirmed delivered dose.
        basalSchedule: extractBasalSchedule(profileDocs.ok ? profileDocs.data : null),
        meta: {
          days,
          entriesFetched: (entries.data || []).length,
          treatmentsFetched: treatments.ok ? (treatments.data || []).length : 0,
          warnings: [
            !treatments.ok ? `Treatments fetch failed: ${treatments.error}` : null,
          ].filter(Boolean),
        },
      }),
    };
  } catch (err) {
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: 'Nightscout fetch failed: ' + err.message }) };
  }
};

// Nightscout's profile.json returns an array of profile-switch documents
// (most recent first); pull the scheduled basal segments out of whichever
// one is currently active. Returns null on anything unexpected — the
// chart just skips gap-filling rather than failing the whole sync.
function extractBasalSchedule(profileDocs) {
  if (!Array.isArray(profileDocs) || !profileDocs.length) return null;
  const doc = profileDocs[0];
  const store = doc.store || {};
  const active = store[doc.defaultProfile] || Object.values(store)[0];
  const basalArr = active?.basal;
  if (!Array.isArray(basalArr) || !basalArr.length) return null;

  const segments = basalArr
    .map(b => {
      const [hh, mm] = String(b.time || '00:00').split(':').map(Number);
      return { startMin: (Number(hh) || 0) * 60 + (Number(mm) || 0), rate: Number(b.value) || 0 };
    })
    .filter(s => Number.isFinite(s.startMin) && s.rate > 0)
    .sort((a, b) => a.startMin - b.startMin);
  if (!segments.length) return null;

  return { timezone: active.timezone || doc.timezone || 'UTC', segments };
}

async function nsFetch(url, headers) {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}
