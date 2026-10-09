-- Návrat 0052: odstraní štítky vyúčtovaných hodin. Data o vyúčtování zůstávají
-- v TEKTOSu (billings.items[].entries[].kronos_entry_id) — po znovunasazení
-- 0052 se štítky obnoví uložením vystavených vyúčtování.
-- POZOR: nejdřív vrátit kód Kronosu, který tabulku vnořuje do selectů záznamů.

begin;
drop table if exists public.time_entry_billings;
commit;
