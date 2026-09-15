// On-demand proxy: fetches glucose/treatment data from a Nightscout
// instance (fed by tconnectsync + a Dexcom Share bridge, or any other
// Nightscout-compatible uploader) and returns it already shaped for
// diabetes-engine.ts. No database writes — same pull-through pattern as
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
// _shared/nightscout-adapter.ts for what that confirmed and corrected.
//
// Ported from src/netlify/functions/diabetes-sync.js — mechanical
// translation to Deno.serve; logic unchanged. Node's crypto.createHash
// is replaced with Web Crypto's crypto.subtle.digest for the SHA1 hash
// (same as the phase-1 webpush.ts rewrite — Deno has no node:crypto
// compat concern here since SHA1 hex-digest is trivial either way, but
// Web Crypto keeps this consistent with the rest of the migration).

import NightscoutAdapter from '../_shared/nightscout-adapter.ts';
const { adaptNightscoutData, adaptProfileSwitches } = NightscoutAdapter;

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

async function sha1Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS });

  const qs = new URL(req.url).searchParams;
  const baseUrl = (qs.get('url') || '').replace(/\/+$/, '');
  if (!baseUrl) {
    return new Response(JSON.stringify({ error: 'Missing url parameter — your Nightscout base URL' }), { status: 400, headers: HEADERS });
  }
  try {
    const parsedUrl = new URL(baseUrl);
    if (parsedUrl.protocol !== 'https:') throw new Error('must be https');
  } catch {
    return new Response(JSON.stringify({ error: 'url must be a valid https:// address' }), { status: 400, headers: HEADERS });
  }

  const days = Math.min(31, Math.max(1, parseInt(qs.get('days') || '', 10) || 14));
  const sinceMs = Date.now() - days * 24 * 60 * 60000;

  const reqHeaders: Record<string, string> = {};
  const secret = qs.get('secret');
  if (secret) reqHeaders['API-SECRET'] = await sha1Hex(secret);
  const token = qs.get('token');
  const tokenQS = token ? `&token=${encodeURIComponent(token)}` : '';

  try {
    const [entries, treatments, profileDocs] = await Promise.all([
      nsFetch(`${baseUrl}/api/v1/entries.json?count=20000&find[date][$gte]=${sinceMs}${tokenQS}`, reqHeaders),
      nsFetch(`${baseUrl}/api/v1/treatments.json?count=5000&find[created_at][$gte]=${new Date(sinceMs).toISOString()}${tokenQS}`, reqHeaders),
      // count=30, not 1 — profile.json's own revision history (a fresh
      // document each time the pump's active default profile actually
      // changes) is the only place a profile switch shows up at all for a
      // tconnectsync feed; there's no distinct "Profile Switch" treatment
      // event for it. 30 is generous headroom for even frequent switching
      // within the 31-day max lookback this endpoint supports.
      nsFetch(`${baseUrl}/api/v1/profile.json?count=30${tokenQS}`, reqHeaders),
    ]);

    if (!entries.ok) {
      return new Response(JSON.stringify({ error: `Nightscout entries fetch failed: ${entries.error}` }), { status: entries.status || 502, headers: HEADERS });
    }

    const adapted = adaptNightscoutData({
      entries: entries.data || [],
      treatments: treatments.ok ? (treatments.data || []) : [],
    });

    return new Response(JSON.stringify({
      ...adapted,
      // Control-IQ only logs a Temp Basal treatment when it actually
      // overrides the scheduled rate — a stretch where it just holds the
      // profile default (or tconnectsync misses a poll) leaves a real
      // hole in Nightscout's own data, not a fitl00p sync-lag artifact.
      // The chart uses this to fill those holes with the *scheduled*
      // rate, visually distinct from a confirmed delivered dose.
      basalSchedule: extractBasalSchedule(profileDocs.ok ? profileDocs.data : null),
      profileSwitches: adaptProfileSwitches(profileDocs.ok ? profileDocs.data : null),
      meta: {
        days,
        entriesFetched: (entries.data || []).length,
        treatmentsFetched: treatments.ok ? (treatments.data || []).length : 0,
        warnings: [
          !treatments.ok ? `Treatments fetch failed: ${treatments.error}` : null,
        ].filter(Boolean),
      },
    }), { status: 200, headers: HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Nightscout fetch failed: ' + (err as Error).message }), { status: 502, headers: HEADERS });
  }
});

// Nightscout's profile.json returns an array of profile-switch documents
// (most recent first); pull the scheduled basal segments out of whichever
// one is currently active. Returns null on anything unexpected — the
// chart just skips gap-filling rather than failing the whole sync.
function extractBasalSchedule(profileDocs: any) {
  if (!Array.isArray(profileDocs) || !profileDocs.length) return null;
  const doc = profileDocs[0];
  const store = doc.store || {};
  const active = store[doc.defaultProfile] || Object.values(store)[0] as any;
  const basalArr = active?.basal;
  if (!Array.isArray(basalArr) || !basalArr.length) return null;

  const segments = basalArr
    .map((b: any) => {
      const [hh, mm] = String(b.time || '00:00').split(':').map(Number);
      return { startMin: (Number(hh) || 0) * 60 + (Number(mm) || 0), rate: Number(b.value) || 0 };
    })
    .filter((s: any) => Number.isFinite(s.startMin) && s.rate > 0)
    .sort((a: any, b: any) => a.startMin - b.startMin);
  if (!segments.length) return null;

  return { timezone: active.timezone || doc.timezone || 'UTC', segments };
}

async function nsFetch(url: string, headers: Record<string, string>) {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}`, data: null as any };
    const data = await res.json();
    return { ok: true, status: res.status, data, error: null as any };
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).message, data: null as any };
  }
}
