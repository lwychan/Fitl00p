// netlify/functions/admin-approve.js
// Admin-only endpoint to approve or reject user registrations.
// Called from the admin panel in the app.

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

  // Verify caller is authenticated
  const jwt = (event.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Not authenticated' }) };

  // Verify caller is admin
  const userRes = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${jwt}`, 'apikey': SB_SERVICE },
  });
  if (!userRes.ok) return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Invalid session' }) };
  const { id: callerId } = await userRes.json();

  const profileRes = await sbFetch(`/rest/v1/profiles?id=eq.${callerId}&select=role`);
  if (!profileRes.ok || profileRes.data?.[0]?.role !== 'admin') {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Admin access required' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { userId, action, note } = body; // action: 'approve' | 'reject'
  if (!userId || !['approve','reject'].includes(action)) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing userId or invalid action' }) };
  }

  const newRole   = action === 'approve' ? 'approved' : 'rejected';
  const now       = new Date().toISOString();

  // Update profile role
  const profileUpdate = await sbFetch(
    `/rest/v1/profiles?id=eq.${userId}`, 'PATCH',
    { role: newRole, approved_by: callerId, approved_at: now }
  );

  // Update approval request
  await sbFetch(
    `/rest/v1/approval_requests?user_id=eq.${userId}`, 'PATCH',
    { status: action === 'approve' ? 'approved' : 'rejected', reviewed_by: callerId, reviewed_at: now, note: note || null }
  );

  if (!profileUpdate.ok) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Failed to update profile' }) };
  }

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({ success: true, userId, action: newRole }),
  };
};

async function sbFetch(path, method = 'GET', body = null) {
  try {
    const res = await fetch(`${SB_URL}${path}`, {
      method,
      headers: {
        'Content-Type':  'application/json',
        'apikey':        SB_SERVICE,
        'Authorization': `Bearer ${SB_SERVICE}`,
        'Prefer':        'return=minimal',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = res.ok && method === 'GET' ? await res.json().catch(() => null) : null;
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err.message };
  }
}
