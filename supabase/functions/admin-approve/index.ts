// Admin-only endpoint to approve or reject user registrations.
// Called from the admin panel in the app.
//
// Ported from src/netlify/functions/admin-approve.js — mechanical
// translation to Deno.serve; logic unchanged.

const SB_URL     = Deno.env.get('SUPABASE_URL');
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  // Same-origin browser requests never trigger a CORS preflight, so this
  // was invisible until the native app started calling this cross-origin
  // — without these two, the browser rejects the OPTIONS preflight for
  // the POST's Content-Type/Authorization headers, and the real request
  // never sends.
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

async function sbFetch(path: string, method = 'GET', body: unknown = null) {
  try {
    const res = await fetch(`${SB_URL}${path}`, {
      method,
      headers: {
        'Content-Type':  'application/json',
        'apikey':        SB_SERVICE!,
        'Authorization': `Bearer ${SB_SERVICE}`,
        'Prefer':        'return=minimal',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = res.ok && method === 'GET' ? await res.json().catch(() => null) : null;
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: (err as Error).message };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: HEADERS });
  }

  // Verify caller is authenticated
  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers: HEADERS });

  // Verify caller is admin
  const userRes = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${jwt}`, 'apikey': SB_SERVICE! },
  });
  if (!userRes.ok) return new Response(JSON.stringify({ error: 'Invalid session' }), { status: 401, headers: HEADERS });
  const { id: callerId } = await userRes.json();

  const profileRes = await sbFetch(`/rest/v1/profiles?id=eq.${callerId}&select=role`);
  if (!profileRes.ok || (profileRes.data as any[])?.[0]?.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403, headers: HEADERS });
  }

  let body: any;
  try { body = JSON.parse(await req.text()); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: HEADERS });
  }

  const { userId, action, note } = body; // action: 'approve' | 'reject'
  if (!userId || !['approve', 'reject'].includes(action)) {
    return new Response(JSON.stringify({ error: 'Missing userId or invalid action' }), { status: 400, headers: HEADERS });
  }

  const newRole = action === 'approve' ? 'approved' : 'rejected';
  const now     = new Date().toISOString();

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
    return new Response(JSON.stringify({ error: 'Failed to update profile' }), { status: 500, headers: HEADERS });
  }

  return new Response(JSON.stringify({ success: true, userId, action: newRole }), { status: 200, headers: HEADERS });
});
