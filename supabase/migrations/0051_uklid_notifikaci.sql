-- 0051: úklid notifikací (docs/AUDIT-2026-09-24.md §5.1).
--
-- Tabulka notifications jen roste — přečtené se nikdy nemažou. Rozhodnutí:
-- přečtené starší 90 dnů pryč. Nepřečtené zůstávají vždy.
--
-- Úklid běží v databázi přes pg_cron každou noc (3:30 UTC), nezávisle na
-- Vercelu a externím cronu. cron.schedule se stejným názvem úlohu jen
-- přepíše — migraci jde pustit znovu.
--
-- Ověření po spuštění:
--   select jobname, schedule, active from cron.job
--    where jobname = 'kronos-notifications-cleanup';
--   select status, return_message, start_time from cron.job_run_details
--    where jobid = (select jobid from cron.job
--                    where jobname = 'kronos-notifications-cleanup')
--    order by start_time desc limit 5;

-- Supabase: pg_cron je v nabídce rozšíření; když hlásí chybu oprávnění,
-- zapnout ho v Database → Extensions a pustit zbytek znovu.
create extension if not exists pg_cron;

begin;

-- jednorázově: co už je teď starší než 90 dnů
delete from public.notifications
 where read_at is not null
   and read_at < now() - interval '90 days';

select cron.schedule(
  'kronos-notifications-cleanup',
  '30 3 * * *',
  $job$delete from public.notifications
        where read_at is not null
          and read_at < now() - interval '90 days'$job$
);

commit;
