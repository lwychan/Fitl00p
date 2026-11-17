// Turns the raw sleep sessions the iOS build sends (start_ms/end_ms/asleep
// hours plus stage hours) into sleep_sessions rows, and the night for each
// wake date into the health_daily sleep_* fields. The classifier is the
// shared src/sleep-sessions.js (via _shared/sleep-sessions.js), so the
// web fallback and this function can't disagree about what a night is.

import SleepSessions from '../_shared/sleep-sessions.js';

const londonDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
const londonHourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export const londonDate = (ms: number): string => londonDayFmt.format(new Date(ms));
export const londonHour = (ms: number): number => {
  const [h, m] = londonHourFmt.format(new Date(ms)).split(':').map(Number);
  return h + m / 60;
};

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export type SessionRow = Record<string, unknown>;
export type NightRow = Record<string, unknown>;

// Validate, de-duplicate and classify. Returns one sleep_sessions row per
// kept session and one health_daily patch per wake date that has a night.
export function sessionRows(input: unknown[], userId: string): { rows: SessionRow[]; nights: NightRow[] } {
  const seen = new Set<number>();
  const valid: { start: number; end: number; asleepHrs: number; deepHrs?: number; remHrs?: number; coreHrs?: number }[] = [];
  for (const item of input.slice(0, 60)) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    if (!finite(s.start_ms) || !finite(s.end_ms) || !finite(s.asleep_hrs)) continue;
    if (s.asleep_hrs <= 0 || s.end_ms <= s.start_ms || seen.has(s.start_ms)) continue;
    seen.add(s.start_ms);
    valid.push({
      start: s.start_ms, end: s.end_ms, asleepHrs: s.asleep_hrs,
      ...(finite(s.deep_hrs) ? { deepHrs: s.deep_hrs } : {}),
      ...(finite(s.rem_hrs) ? { remHrs: s.rem_hrs } : {}),
      ...(finite(s.core_hrs) ? { coreHrs: s.core_hrs } : {}),
    });
  }

  const classified = SleepSessions.classifySessions(valid, londonDate, londonHour) as Record<string, any>[];
  const iso = (ms: number) => new Date(ms).toISOString();

  const rows: SessionRow[] = classified.map(s => ({
    user_id: userId,
    start_at: iso(s.start),
    end_at: iso(s.end),
    wake_date: s.wakeDate,
    kind: s.kind,
    source: 'healthkit',
    asleep_hrs: s.asleepHrs,
    deep_hrs: s.deepHrs ?? null,
    rem_hrs: s.remHrs ?? null,
    core_hrs: s.coreHrs ?? null,
    flag: s.flag ?? null,
  }));

  // health_daily.sleep_* is the night only; naps and dozes never go there.
  const nights: NightRow[] = classified
    .filter(s => s.kind === 'night')
    .map(s => ({
      user_id: userId,
      log_date: s.wakeDate,
      sleep_total_hrs: s.asleepHrs,
      sleep_start: iso(s.start),
      sleep_end: iso(s.end),
      ...(finite(s.deepHrs) ? { sleep_deep_hrs: s.deepHrs } : {}),
      ...(finite(s.remHrs) ? { sleep_rem_hrs: s.remHrs } : {}),
      ...(finite(s.coreHrs) ? { sleep_core_hrs: s.coreHrs } : {}),
    }));

  return { rows, nights };
}
