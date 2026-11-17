// Run: deno test supabase/functions/health-ingest/sessions.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { sessionRows } from './sessions.ts';

const USER = '11111111-2222-4333-8444-555555555555';
// London in November is GMT, so UTC clock times are local clock times here.
const t = (iso: string) => Date.parse(iso);
const raw = (start: string, end: string, asleep: number, extra: Record<string, unknown> = {}) =>
  ({ start_ms: t(start), end_ms: t(end), asleep_hrs: asleep, ...extra });

Deno.test('night and afternoon nap both kept; only the night goes to health_daily', () => {
  const { rows, nights } = sessionRows([
    raw('2026-11-02T23:08:00Z', '2026-11-03T07:09:00Z', 8.0),
    raw('2026-11-03T13:35:00Z', '2026-11-03T16:02:00Z', 2.42),
  ], USER);
  assertEquals(rows.length, 2);
  assertEquals(rows.map(r => r.kind).sort(), ['nap', 'night']);
  assertEquals(nights.length, 1);
  assertEquals(nights[0].log_date, '2026-11-03');
  assertEquals(nights[0].sleep_total_hrs, 8.0);
  assertEquals(nights[0].sleep_end, '2026-11-03T07:09:00.000Z');
});

Deno.test('sessions with no asleep time are dropped and nothing is written for them', () => {
  const { rows } = sessionRows([
    raw('2026-11-03T10:00:00Z', '2026-11-03T10:30:00Z', 0),
    raw('2026-11-02T23:00:00Z', '2026-11-03T07:00:00Z', 7),
  ], USER);
  assertEquals(rows.length, 1);
});

Deno.test('duplicate start_ms in one payload is kept once', () => {
  const dup = raw('2026-11-02T23:00:00Z', '2026-11-03T07:00:00Z', 7);
  const { rows } = sessionRows([dup, { ...dup, asleep_hrs: 7.5 }], USER);
  assertEquals(rows.length, 1);
});

Deno.test('a session over 14 hours is flagged long', () => {
  const { rows } = sessionRows([raw('2026-11-08T10:00:00Z', '2026-11-09T01:00:00Z', 14.5)], USER);
  assertEquals(rows[0].flag, 'long');
});

Deno.test('rows carry the user, source healthkit and the wake date of the session end', () => {
  const { rows } = sessionRows([raw('2026-11-02T23:00:00Z', '2026-11-03T07:00:00Z', 7)], USER);
  assertEquals(rows[0].user_id, USER);
  assertEquals(rows[0].source, 'healthkit');
  assertEquals(rows[0].wake_date, '2026-11-03');
});

Deno.test('malformed entries are ignored without throwing', () => {
  const { rows } = sessionRows([
    { start_ms: 'x', end_ms: 1, asleep_hrs: 2 },
    null,
    raw('2026-11-02T23:00:00Z', '2026-11-03T07:00:00Z', 7),
  ] as unknown[], USER);
  assertEquals(rows.length, 1);
});
