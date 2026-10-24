-- Capped reminders (applied 2026-10-24). pg_cron runs in UTC, so each window
-- covers both BST and GMT; the functions themselves act only at their London times.
-- Tirzepatide nudges 12:00/15:00/17:00/19:00 London (11:00-19:00 UTC in BST, 12:00-19:00 in GMT).
select cron.schedule('notify-tirzepatide', '*/15 10-19 * * *', $$select private.invoke_edge_fn('notify-tirzepatide')$$);
-- Peptide nudge 15:30 London (14:30 UTC in BST, 15:30 in GMT).
select cron.schedule('notify-peptide', '*/15 14-15 * * *', $$select private.invoke_edge_fn('notify-peptide')$$);
-- notify-oral-meds stays hourly ('0 * * * *'); it acts only at 21:00 London.
