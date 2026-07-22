// netlify/functions/health-apikey.js
// Called from the fitl00p app (authenticated) to generate or retrieve
// the user's personal API key for Health Auto Export.

const crypto = require('crypto');

const SB_URL     = process.env.SUPABASE_URL;
const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS };

  // Verify the caller is authenticated via Supabase JWT
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Not authenticated' }) };

  // Verify JWT and get user_id
  const userRes = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${jwt}`, 'apikey': SB_SERVICE },
  });
  if (!userRes.ok) return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Invalid session' }) };
  const { id: user_id } = await userRes.json();

  if (event.httpMethod === 'GET') {
    // Return whether a key exists (never return the key itself after creation)
    const res = await sbFetch(`/rest/v1/health_api_keys?user_id=eq.${user_id}&select=label,created_at,last_used`);
    return {
      statusCode: 200, headers: HEADERS,
      body: JSON.stringify({ hasKey: !!(res.data?.length), key: res.data?.[0] || null }),
    };
  }

  if (event.httpMethod === 'POST') {
    // Generate a new API key — show it once, store only the hash
    const rawKey  = crypto.randomBytes(32).toString('hex'); // 64-char hex string
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    // Delete any existing key for this user first
    await sbFetch(`/rest/v1/health_api_keys?user_id=eq.${user_id}`, 'DELETE');

    // Insert new key
    const insertRes = await sbFetch('/rest/v1/health_api_keys', 'POST', {
      user_id,
      key_hash: keyHash,
      label: 'Health Auto Export',
    }, { 'Prefer': 'return=minimal' });

    if (!insertRes.ok) {
      return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Failed to create key' }) };
    }

    // Return the raw key ONCE — it will never be shown again
    return {
      statusCode: 200, headers: HEADERS,
      body: JSON.stringify({
        key: rawKey,
        endpoint: `${process.env.URL || 'https://your-app.netlify.app'}/.netlify/functions/health-sync`,
        instructions: 'Copy this key now — it will not be shown again.',
      }),
    };
  }

  if (event.httpMethod === 'DELETE') {
    await sbFetch(`/rest/v1/health_api_keys?user_id=eq.${user_id}`, 'DELETE');
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ deleted: true }) };
  }

  return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
};

async function sbFetch(path, method = 'GET', body = null, extraHeaders = {}) {
  try {
    const res = await fetch(`${SB_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'apikey': SB_SERVICE,
        'Authorization': `Bearer ${SB_SERVICE}`,
        ...extraHeaders,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = res.ok && method !== 'DELETE' ? await res.json().catch(() => null) : null;
    return { ok: res.ok, status: res.status, data, error: !res.ok ? await res.text().catch(() => '') : null };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err.message };
  }
}
