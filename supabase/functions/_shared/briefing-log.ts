// public.briefing_log helpers: every briefing and capped reminder claims its
// (user, kind, day) row BEFORE sending and only sends when the claim landed,
// so overlapping cron runs can never double-send.

async function logWrite(path: string, method: string, body: unknown, prefer: string) {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const res = await fetch(`${Deno.env.get('SUPABASE_URL')}${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: prefer },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} briefing_log → ${res.status}: ${await res.text()}`);
  return prefer.includes('return=representation') ? res.json() : null;
}

// true only for the run that inserted today's row.
async function claim(userId: string, kind: string, dateStr: string) {
  const rows = await logWrite('/rest/v1/briefing_log?on_conflict=user_id,kind,sent_date', 'POST',
    { user_id: userId, kind, sent_date: dateStr }, 'resolution=ignore-duplicates,return=representation');
  return Array.isArray(rows) && rows.length > 0;
}

async function recordBody(userId: string, kind: string, dateStr: string, body: string) {
  await logWrite(`/rest/v1/briefing_log?user_id=eq.${userId}&kind=eq.${kind}&sent_date=eq.${dateStr}`, 'PATCH',
    { body }, 'return=minimal').catch(() => {});
}

// Kinds already sent to this user today.
async function sentKinds(sbFetch: (p: string) => Promise<any>, userId: string, dateStr: string): Promise<string[]> {
  const { data } = await sbFetch(`/rest/v1/briefing_log?user_id=eq.${userId}&sent_date=eq.${dateStr}&select=kind`);
  return ((data as any[]) || []).map(r => r.kind);
}

export { claim, recordBody, sentKinds };
