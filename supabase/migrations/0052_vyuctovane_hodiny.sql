-- 0052: vyúčtované hodiny — štítek u časového záznamu, který už je ve
-- vyúčtování v TEKTOSu („Vyúčtováno 2603", po úhradě „· uhrazeno").
-- Design: TEKTOS docs/plans/2026-10-09-vyuctovane-hodiny-kronos-design.md
--
--  * Samostatná tabulka (ne sloupec v time_entries): autor záznamu ji přes
--    API nepřečte — štítek vidí jen admin firmy (a super-admin).
--  * Zapisuje výhradně TEKTOS přes service role (systémové napojení DB↔DB),
--    proto žádné insert/update/delete politiky.
--  * PK = time_entry_id → záznam může být nejvýš v jednom vyúčtování.
--  * Smazání záznamu štítek smaže (cascade); úprava záznamu ho nechá.
--
-- Bez dopadu na stávající politiky. Ověření po spuštění:
--   select count(*) from public.time_entry_billings;          -- 0
--   select polname, polcmd from pg_policy
--    where polrelid = 'public.time_entry_billings'::regclass; -- jen select

begin;

create table if not exists public.time_entry_billings (
  time_entry_id uuid primary key references public.time_entries (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  billing_number text not null,
  billing_status text not null check (billing_status in ('issued', 'paid')),
  billing_url text,
  source_billing_id uuid not null,
  updated_at timestamptz not null default now()
);

create index if not exists time_entry_billings_source_idx
  on public.time_entry_billings (source_billing_id);
create index if not exists time_entry_billings_ws_idx
  on public.time_entry_billings (workspace_id);

alter table public.time_entry_billings enable row level security;

drop policy if exists teb_select on public.time_entry_billings;
create policy teb_select on public.time_entry_billings for select
  to authenticated
  using (
    (select public.is_super_admin())
    -- přetypování: bez něj Postgres bere (select …) jako poddotaz a porovná uuid s uuid[]
    or workspace_id = any ((select public.my_admin_ws_ids())::uuid[])
  );

commit;
