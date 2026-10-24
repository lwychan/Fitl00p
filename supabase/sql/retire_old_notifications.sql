-- Old pushes replaced by the morning/evening briefings (2026-10-24).
-- Morning side, run once the first morning briefing had delivered:
select cron.unschedule(j) from unnest(array['notify-daily-summary','notify-weighin','notify-weighin-gemma']) j;
-- Evening side, run once the first evening briefing has delivered:
-- select cron.unschedule('notify-sleep-target');
-- Then: npx -y supabase@2.122.0 functions delete <name> --project-ref nxawnkpzjixishcerxcv
-- for notify-daily-summary, notify-weighin, notify-weighin-gemma, notify-sleep-target.
