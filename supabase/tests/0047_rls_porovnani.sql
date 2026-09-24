-- ============================================================================
-- Test k migraci 0047_rls_vykon.sql — spouštět na PRODUKCI PŘED nasazením 0047.
--
-- !!! CHYBA NA KONCI JE ZÁMĚR — VRACÍ VŠE ZPĚT !!!
-- Skript je jediný blok „do". Končí příkazem raise exception, jehož text je
-- výsledek testu; tím PostgreSQL odvolá celou transakci (nové funkce, politiky,
-- přepnutí role i JWT). V databázi nezůstane nic. Data se jen čtou (SELECT).
--
-- Jak: Supabase → SQL Editor jako postgres (přepínač role v editoru nechat na
-- postgres), vložit CELÝ soubor, Run. Pouštět mimo špičku (viz Zámky).
--
-- Výsledek = text chyby, první řádek:
--   „OK — žádný rozdíl"  → 0047 lze nasadit.
--   „ROZDÍLY: N"         → 0047 NENASAZOVAT; pod tím až 30 rozdílů ve tvaru
--                          „tabulka[politika.using|check] / uživatel: před počet → po počet".
--   „NEÚPLNÉ — …"        → vypršel c_time_budget; zvýšit ho (nebo snížit
--                          c_max_users) a pustit znovu. Nenasazovat.
--   „Test selhal …"      → chyba běhu (v závorce kde). Nenasazovat.
--   „… · POZOR: 0047 už je nasazená …" → test nic neověřil; místo něj pustit
--                          0047_rls_porovnani_po.sql (porovná stav s návratem).
-- Pod tím souhrn a časy vzorových dotazů „před X ms → po Y ms".
-- Když editor spadne na timeout, snížit c_time_budget (např. na 45 s).
--
-- Co se porovnává — pro „nepřihlášeného" (JWT bez sub) a každého uživatele
-- z profiles (max c_max_users; admin, člen a super-admin vždy):
--   1. staré helpery (is_ws_member, is_ws_admin, is_project_member,
--      shares_workspace) proti novým množinám, přes VŠECHNY řádky;
--   2. jako role authenticated s jeho JWT otisk 24 tabulek: count(*) + md5
--      seřazených primárních klíčů viditelných řádků;
--   3. u UPDATE/DELETE politik, které 0047 přepisuje, otisk řádků, které
--      navíc projdou jejich USING (a WITH CHECK na stávajících řádcích);
--      výraz se bere z pg_policies. PostgREST u UPDATE/DELETE vždy filtruje,
--      takže „viditelné ∩ USING" je přesně to, co uživatel smí změnit/smazat.
--      WITH CHECK na NOVÝCH řádcích obecně vyzkoušet nejde — proto jsou
--      zápisové politiky v 0047 přepsané čistě mechanicky (stejná logická
--      struktura, jen záměna helperů za ověřené množinové tvary; bod 1).
-- Nejdřív se měří se starými politikami, potom v PODTRANSAKCI s politikami
-- z 0047, která se hned odvolá. Když se otisky liší, změří se znovu staré:
-- stejné → rozdíl je v politikách; jiné → mezitím se měnila data, zkusí znovu.
--
-- Zámky: drop/create policy bere ACCESS EXCLUSIVE zámek na 19 tabulek; drží
-- se jen během měření JEDNOHO uživatele s novými politikami (typicky desetiny
-- sekundy), pak se uvolní — aplikace mezitím chvilku čeká. Když zámek nejde
-- získat do c_lock_timeout, test chvilku počká a zkusí to znovu.
--
-- c_ddl_functions a c_ddl_policies jsou DOSLOVA zkopírované úseky z migrace
-- (včetně značek >>> 0047:… / <<< 0047:…). Oba soubory musí být v souladu —
-- po každé úpravě 0047 úseky zkopírovat znovu.
-- ============================================================================
do $$
declare
  -- ------------------------------------------------------------ nastavení
  c_max_users    constant int := 200;                 -- strop uživatelů
  c_time_budget  constant interval := '45 seconds';   -- pak už nebere další (limit dashboardu)
  c_write_checks constant boolean := true;            -- i výrazy UPDATE/DELETE politik
  c_runs         constant int := 3;                   -- časy: nejlepší z N běhů
  c_lock_timeout constant text := '500ms';            -- čekání na zámek tabulek
  c_lock_tries   constant int := 20;                  -- pokusů o zámek na uživatele
  c_max_lines    constant int := 30;                  -- řádků s rozdíly ve výpisu
  c_tables       constant text[] := array[
    'profiles', 'workspaces', 'workspace_members', 'projects', 'project_members',
    'board_columns', 'tasks', 'task_assignees', 'task_labels', 'task_comments',
    'task_followups', 'task_contact_assignees', 'task_attachments',
    'task_activity', 'checklists', 'checklist_items', 'time_entries', 'labels',
    'contacts', 'assign_grants', 'hr_grants', 'project_categories',
    'notifications', 'task_priority'];
  c_queries      constant text[] := array[
    'select count(*) from public.tasks',
    'select count(*) from public.task_assignees',
    'select count(*) from public.task_comments',
    'select count(*) from public.time_entries',
    'select count(*) from public.projects',
    'select count(*) from public.profiles'];
  -- otisk skupiny řádků „počet:md5 seřazených PK"; %1$s = případný filter (…)
  c_agg constant text :=
    '(count(*)%1$s)::text || '':'' || coalesce(md5(string_agg(k, '','' order by k collate "C")%1$s), ''-'')';

  -- ------------------------------------------------------------ DDL z 0047 (DOSLOVA)
  c_ddl_functions constant text := $ddl$
-- >>> 0047:funkce
-- Pole id pro přihlášeného (auth.uid()). security definer → čtou tabulky bez
-- RLS jako is_ws_member z 0001, takže v politikách nehrozí rekurze. Execute
-- zůstává i anon (jako u is_ws_member) — politiky se počítají i nepřihlášeným.

-- workspaces, kde jsem člen (is_ws_member bez super-admina)
create or replace function public.my_ws_ids()
returns uuid[] language sql stable security definer set search_path = public
as $fn$
  select coalesce(array_agg(m.workspace_id), '{}')
  from public.workspace_members m
  where m.user_id = auth.uid()
$fn$;

-- workspaces, kde jsem admin (is_ws_admin bez super-admina)
create or replace function public.my_admin_ws_ids()
returns uuid[] language sql stable security definer set search_path = public
as $fn$
  select coalesce(array_agg(m.workspace_id), '{}')
  from public.workspace_members m
  where m.user_id = auth.uid() and m.role = 'admin'
$fn$;

-- projekty, kde jsem člen (is_project_member)
create or replace function public.my_project_ids()
returns uuid[] language sql stable security definer set search_path = public
as $fn$
  select coalesce(array_agg(pm.project_id), '{}')
  from public.project_members pm
  where pm.user_id = auth.uid()
$fn$;

-- lidé se společným workspace, včetně mě (shares_workspace)
create or replace function public.my_co_member_ids()
returns uuid[] language sql stable security definer set search_path = public
as $fn$
  select coalesce(array_agg(distinct b.user_id), '{}')
  from public.workspace_members a
  join public.workspace_members b on b.workspace_id = a.workspace_id
  where a.user_id = auth.uid()
$fn$;

-- lidé, na jejichž výkazy mám HR grant s can_hr — stejné tabulky a filtry
-- jako exists (…) v entries_select, jen bez vazby na workspace řádku
create or replace function public.my_hr_target_ids()
returns uuid[] language sql stable security definer set search_path = public
as $fn$
  select coalesce(array_agg(distinct g.target_id), '{}')
  from public.hr_grants g
  join public.workspace_members wm
    on wm.workspace_id = g.workspace_id and wm.user_id = g.user_id
  where g.user_id = auth.uid() and wm.can_hr
$fn$;
-- <<< 0047:funkce
$ddl$;
  c_ddl_policies constant text := $ddl$
-- >>> 0047:politiky
-- Nad každou politikou: soubor:řádek její poslední (platné) definice.

-- ================================================================ profiles

-- 0001_init.sql:132
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select
  using (id = (select auth.uid())
    or (select public.is_super_admin())
    or id = any ((select public.my_co_member_ids())::uuid[]));

-- 0010_avatars.sql:22 (admin_shares_workspace dál per řádek — mění se 1 profil)
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update
  using (id = (select auth.uid()) or public.admin_shares_workspace(id))
  with check (id = (select auth.uid()) or public.admin_shares_workspace(id));

-- ================================================================ workspaces

-- 0001_init.sql:142
drop policy if exists workspaces_select on public.workspaces;
create policy workspaces_select on public.workspaces for select
  using ((select public.is_super_admin())
    or id = any ((select public.my_ws_ids())::uuid[]));

-- 0001_init.sql:146
drop policy if exists workspaces_update on public.workspaces;
create policy workspaces_update on public.workspaces for update
  using ((select public.is_super_admin()));

-- 0001_init.sql:148
drop policy if exists workspaces_delete on public.workspaces;
create policy workspaces_delete on public.workspaces for delete
  using ((select public.is_super_admin()));

-- ================================================================ workspace_members

-- 0001_init.sql:153
drop policy if exists members_select on public.workspace_members;
create policy members_select on public.workspace_members for select
  using ((select public.is_super_admin())
    or workspace_id = any ((select public.my_ws_ids())::uuid[]));

-- 0001_init.sql:158
drop policy if exists members_update on public.workspace_members;
create policy members_update on public.workspace_members for update
  using ((select public.is_super_admin()));

-- 0001_init.sql:160
drop policy if exists members_delete on public.workspace_members;
create policy members_delete on public.workspace_members for delete
  using ((select public.is_super_admin())
    or (((select public.is_super_admin())
         or workspace_id = any ((select public.my_admin_ws_ids())::uuid[]))
        and role = 'member')
    or user_id = (select auth.uid()));

-- ================================================================ projects

-- 0004_project_members.sql:58
drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects for select
  using (((select public.is_super_admin())
          or workspace_id = any ((select public.my_admin_ws_ids())::uuid[]))
    or id = any ((select public.my_project_ids())::uuid[]));

-- 0001_init.sql:170
drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects for update
  using ((select public.is_super_admin())
    or workspace_id = any ((select public.my_admin_ws_ids())::uuid[]));

-- 0001_init.sql:172
drop policy if exists projects_delete on public.projects;
create policy projects_delete on public.projects for delete
  using ((select public.is_super_admin())
    or workspace_id = any ((select public.my_admin_ws_ids())::uuid[]));

-- ================================================================ project_members

-- 0004_project_members.sql:50
drop policy if exists pm_delete on public.project_members;
create policy pm_delete on public.project_members for delete
  using (exists (select 1 from public.projects p
                 where p.id = project_id
                   and ((select public.is_super_admin())
                        or p.workspace_id = any ((select public.my_admin_ws_ids())::uuid[]))));

-- ================================================================ board_columns

-- 0004_project_members.sql:88
drop policy if exists columns_select on public.board_columns;
create policy columns_select on public.board_columns for select
  using (((select public.is_super_admin())
          or workspace_id = any ((select public.my_admin_ws_ids())::uuid[]))
    or project_id = any ((select public.my_project_ids())::uuid[]));

-- 0004_project_members.sql:98
drop policy if exists columns_update on public.board_columns;
create policy columns_update on public.board_columns for update
  using (((select public.is_super_admin())
          or workspace_id = any ((select public.my_admin_ws_ids())::uuid[]))
    or project_id = any ((select public.my_project_ids())::uuid[]));

-- 0004_project_members.sql:102
drop policy if exists columns_delete on public.board_columns;
create policy columns_delete on public.board_columns for delete
  using (((select public.is_super_admin())
          or workspace_id = any ((select public.my_admin_ws_ids())::uuid[]))
    or project_id = any ((select public.my_project_ids())::uuid[]));

-- ================================================================ tasks

-- 0040_oprava_insert_returning.sql:9
drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks for select
  using (
    (not is_private or created_by = (select auth.uid()))
    and (
      ((select public.is_super_admin())
       or workspace_id = any ((select public.my_admin_ws_ids())::uuid[]))
      or lead_id = (select auth.uid())
      or (project_id is not null
          and project_id = any ((select public.my_project_ids())::uuid[])
          and (created_by = (select auth.uid()) -- přímo na řádce: drží i INSERT ... RETURNING
               or public.is_task_mine(id)
               or (parent_id is not null and public.is_task_mine(parent_id))))
      or (project_id is null
          and ((select public.is_super_admin())
               or workspace_id = any ((select public.my_ws_ids())::uuid[]))
          and (created_by = (select auth.uid()) or public.is_task_assignee(id)))
    )
  );

-- 0040_oprava_insert_returning.sql:25
drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update
  using (
    (not is_private or created_by = (select auth.uid()))
    and (
      ((select public.is_super_admin())
       or workspace_id = any ((select public.my_admin_ws_ids())::uuid[]))
      or lead_id = (select auth.uid())
      or (project_id is not null
          and project_id = any ((select public.my_project_ids())::uuid[])
          and (created_by = (select auth.uid())
               or public.is_task_mine(id)
               or (parent_id is not null and public.is_task_mine(parent_id))))
      or (project_id is null
          and ((select public.is_super_admin())
               or workspace_id = any ((select public.my_ws_ids())::uuid[]))
          and (created_by = (select auth.uid()) or public.is_task_assignee(id)))
    )
  )
  with check (
    (not is_private or created_by = (select auth.uid()))
    and (
      (project_id is not null
        and (((select public.is_super_admin())
              or workspace_id = any ((select public.my_admin_ws_ids())::uuid[]))
             or project_id = any ((select public.my_project_ids())::uuid[])
             or lead_id = (select auth.uid()))
        and exists (select 1 from public.projects p
                    where p.id = project_id and p.workspace_id = tasks.workspace_id)
        and (column_id is null or exists
          (select 1 from public.board_columns c
           where c.id = column_id and c.project_id = tasks.project_id)))
      or (project_id is null
        and (((select public.is_super_admin())
              or workspace_id = any ((select public.my_ws_ids())::uuid[]))
             or lead_id = (select auth.uid()))
        and column_id is null)
    )
  );

-- 0001_init.sql:188
drop policy if exists tasks_delete on public.tasks;
create policy tasks_delete on public.tasks for delete
  using (created_by = (select auth.uid())
    or ((select public.is_super_admin())
        or workspace_id = any ((select public.my_admin_ws_ids())::uuid[])));

-- ================================================================ task_assignees

-- 0017_assign_grants.sql:44
drop policy if exists ta_delete on public.task_assignees;
create policy ta_delete on public.task_assignees for delete
  using (user_id = (select auth.uid())
    or exists (select 1 from public.tasks t
               where t.id = task_assignees.task_id
                 and (((select public.is_super_admin())
                       or t.workspace_id = any ((select public.my_admin_ws_ids())::uuid[]))
                   or exists (select 1 from public.assign_grants g
                              where g.workspace_id = t.workspace_id
                                and g.user_id = (select auth.uid())
                                and g.target_id = task_assignees.user_id))));

-- ================================================================ time_entries

-- 0026_hr_vykazy.sql:34
-- Navíc předfiltr „user_id = any (my_hr_target_ids())": je to nutná podmínka
-- exists (…) za ním (stejné tabulky a filtry, bez vazby na workspace), takže
-- „předfiltr and exists" ≡ „exists". Lidem bez HR grantu se exists nespouští.
drop policy if exists entries_select on public.time_entries;
create policy entries_select on public.time_entries for select
  using (
    user_id = (select auth.uid())
    or ((select public.is_super_admin())
        or workspace_id = any ((select public.my_admin_ws_ids())::uuid[]))
    or (user_id = any ((select public.my_hr_target_ids())::uuid[])
        and exists (
          select 1
          from public.hr_grants g
          join public.workspace_members wm
            on wm.workspace_id = g.workspace_id and wm.user_id = g.user_id
          where g.workspace_id = time_entries.workspace_id
            and g.user_id = (select auth.uid())
            and g.target_id = time_entries.user_id
            and wm.can_hr))
  );

-- 0043_hr_upravy_vykazu.sql:6
drop policy if exists entries_update on public.time_entries;
create policy entries_update on public.time_entries for update
  using (
    user_id = (select auth.uid())
    or ((select public.is_super_admin())
        or workspace_id = any ((select public.my_admin_ws_ids())::uuid[]))
    or exists (
      select 1
      from public.hr_grants g
      join public.workspace_members wm
        on wm.workspace_id = g.workspace_id and wm.user_id = g.user_id
      where g.workspace_id = time_entries.workspace_id
        and g.user_id = (select auth.uid())
        and g.target_id = time_entries.user_id
        and wm.can_hr
    )
  );

-- 0001_init.sql:201
drop policy if exists entries_delete on public.time_entries;
create policy entries_delete on public.time_entries for delete
  using (user_id = (select auth.uid())
    or ((select public.is_super_admin())
        or workspace_id = any ((select public.my_admin_ws_ids())::uuid[])));

-- ================================================================ task_comments

-- 0004_project_members.sql:107
drop policy if exists comments_select on public.task_comments;
create policy comments_select on public.task_comments for select
  using (((select public.is_super_admin())
          or workspace_id = any ((select public.my_ws_ids())::uuid[]))
    and exists (select 1 from public.tasks t where t.id = task_id));

-- 0002_kanban.sql:78
drop policy if exists comments_update on public.task_comments;
create policy comments_update on public.task_comments for update
  using (author_id = (select auth.uid()));

-- 0002_kanban.sql:80
drop policy if exists comments_delete on public.task_comments;
create policy comments_delete on public.task_comments for delete
  using (author_id = (select auth.uid())
    or ((select public.is_super_admin())
        or workspace_id = any ((select public.my_admin_ws_ids())::uuid[])));

-- ================================================================ task_attachments

-- 0018_task_attachments.sql:45
drop policy if exists task_attachments_delete on public.task_attachments;
create policy task_attachments_delete on public.task_attachments for delete
  using (uploaded_by = (select auth.uid())
    or ((select public.is_super_admin())
        or workspace_id = any ((select public.my_admin_ws_ids())::uuid[])));

-- ================================================================ task_followups

-- 0037_cekam_od_do.sql:15
drop policy if exists task_followups_update on public.task_followups;
create policy task_followups_update on public.task_followups for update
  using (created_by = (select auth.uid())
    or ((select public.is_super_admin())
        or workspace_id = any ((select public.my_admin_ws_ids())::uuid[])))
  with check (created_by = (select auth.uid())
    or ((select public.is_super_admin())
        or workspace_id = any ((select public.my_admin_ws_ids())::uuid[])));

-- ================================================================ labels

-- 0005_priority_labels.sql:32
drop policy if exists labels_select on public.labels;
create policy labels_select on public.labels for select
  using ((select public.is_super_admin())
    or workspace_id = any ((select public.my_ws_ids())::uuid[]));

-- 0005_priority_labels.sql:36
drop policy if exists labels_update on public.labels;
create policy labels_update on public.labels for update
  using ((select public.is_super_admin())
    or workspace_id = any ((select public.my_ws_ids())::uuid[]));

-- 0005_priority_labels.sql:38
drop policy if exists labels_delete on public.labels;
create policy labels_delete on public.labels for delete
  using ((select public.is_super_admin())
    or workspace_id = any ((select public.my_admin_ws_ids())::uuid[]));

-- ================================================================ contacts

-- 0021_delegace.sql:43
drop policy if exists contacts_select on public.contacts;
create policy contacts_select on public.contacts for select
  using ((select public.is_super_admin())
    or workspace_id = any ((select public.my_ws_ids())::uuid[]));

-- 0021_delegace.sql:47
drop policy if exists contacts_update on public.contacts;
create policy contacts_update on public.contacts for update
  using ((select public.is_super_admin())
    or workspace_id = any ((select public.my_ws_ids())::uuid[]));

-- 0021_delegace.sql:49
drop policy if exists contacts_delete on public.contacts;
create policy contacts_delete on public.contacts for delete
  using ((select public.is_super_admin())
    or workspace_id = any ((select public.my_admin_ws_ids())::uuid[]));

-- ================================================================ assign_grants

-- 0017_assign_grants.sql:15
drop policy if exists grants_select on public.assign_grants;
create policy grants_select on public.assign_grants for select
  using ((select public.is_super_admin())
    or workspace_id = any ((select public.my_ws_ids())::uuid[]));

-- 0017_assign_grants.sql:19
drop policy if exists grants_delete on public.assign_grants;
create policy grants_delete on public.assign_grants for delete
  using ((select public.is_super_admin())
    or workspace_id = any ((select public.my_admin_ws_ids())::uuid[]));

-- ================================================================ hr_grants

-- 0026_hr_vykazy.sql:22
drop policy if exists hr_grants_select on public.hr_grants;
create policy hr_grants_select on public.hr_grants for select
  using ((select public.is_super_admin())
    or workspace_id = any ((select public.my_ws_ids())::uuid[]));

-- 0026_hr_vykazy.sql:26
drop policy if exists hr_grants_delete on public.hr_grants;
create policy hr_grants_delete on public.hr_grants for delete
  using ((select public.is_super_admin())
    or workspace_id = any ((select public.my_admin_ws_ids())::uuid[]));

-- ================================================================ project_categories

-- 0036_kategorie_projektu.sql:20
drop policy if exists project_categories_select on public.project_categories;
create policy project_categories_select on public.project_categories for select
  using ((select public.is_super_admin())
    or workspace_id = any ((select public.my_ws_ids())::uuid[]));

-- 0036_kategorie_projektu.sql:24
drop policy if exists project_categories_update on public.project_categories;
create policy project_categories_update on public.project_categories for update
  using ((select public.is_super_admin())
    or workspace_id = any ((select public.my_admin_ws_ids())::uuid[]));

-- 0036_kategorie_projektu.sql:26
drop policy if exists project_categories_delete on public.project_categories;
create policy project_categories_delete on public.project_categories for delete
  using ((select public.is_super_admin())
    or workspace_id = any ((select public.my_admin_ws_ids())::uuid[]));

-- ================================================================ notifications

-- 0009_notifications_inapp.sql:11
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select
  using (user_id = (select auth.uid()));

-- 0009_notifications_inapp.sql:13
drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications for update
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ================================================================ task_priority

-- 0031_priority_list.sql:18
drop policy if exists task_priority_select on public.task_priority;
create policy task_priority_select on public.task_priority for select
  using (user_id = (select auth.uid()));

-- 0031_priority_list.sql:22
drop policy if exists task_priority_update on public.task_priority;
create policy task_priority_update on public.task_priority for update
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- 0031_priority_list.sql:24
drop policy if exists task_priority_delete on public.task_priority;
create policy task_priority_delete on public.task_priority for delete
  using (user_id = (select auth.uid()));
-- <<< 0047:politiky
$ddl$;

  -- ------------------------------------------------------------ stav
  v_start      timestamptz := clock_timestamp();
  v_already    boolean;
  v_rewritten  text[];             -- „tabulka.politika" přepsané v 0047
  v_lock_sql   text;
  v_t          text;
  v_pk         text;
  v_cols       text;
  v_aggs       text;
  v_expr       text;
  v_kind       text;
  v_x          text;
  v_n          int;
  v_i          int;
  v_j          int;
  v_q          int;
  v_r          int;
  r_pol        record;
  v_tables     text[] := '{}';
  v_pks        text[] := '{}';
  v_sql_old    text[] := '{}';     -- dotaz na otisky tabulky, staré politiky
  v_sql_new    text[];             -- totéž s politikami 0047 (postaví 1. podtransakce)
  v_sql_tmp    text[];
  v_parts      text[] := '{}';     -- popisek každého otisku
  v_pol_tab    text[] := '{}';     -- výrazy politik: tabulka / název / using|check
  v_pol_name   text[] := '{}';
  v_pol_kind   text[] := '{}';
  v_struct_old text[];
  v_struct_new text[];
  v_expr_old   text[];
  v_expr_new   text[];
  v_changed    int := 0;
  v_sa         uuid;
  v_admin      uuid;
  v_member     uuid;
  v_samples    uuid[] := '{}';
  v_sroles     text[] := '{}';
  v_users      uuid[];
  v_uid        uuid;
  v_ulabel     text;
  v_claims     text;
  v_sidx       int;
  v_nq         int := cardinality(c_queries);
  v_tm_old     numeric[];
  v_tm_new     numeric[];
  v_timed_old  boolean;
  v_timed_new  boolean;
  v_t0         timestamptz;
  v_best       numeric;
  v_dummy      bigint;
  v_step       int;
  v_mode       int;
  v_round      int;
  v_state      text;
  v_ok         boolean;
  v_try        int;
  v_arr        text[];
  v_cur        text[];
  v_old        text[];
  v_new        text[];
  v_ctx        text := '';
  v_ndiff      int := 0;
  v_lines      text[] := '{}';
  v_slines     text[] := '{}';
  v_nusers     int := 0;
  v_cut        boolean := false;
  v_t_lock     timestamptz;
  v_lock_max   numeric := 0;       -- nejdelší držení zámků tabulek (ms)
  v_report     text;
begin
  -- ============================================================ 0) příprava
  if not exists (select 1 from pg_class c
                  where c.oid = 'public.tasks'::regclass
                    and pg_has_role(current_user, c.relowner, 'MEMBER')) then
    raise exception 'Test selhal: spusť jako vlastník tabulek (postgres), ne jako %', current_user;
  end if;
  if not pg_has_role(current_user, 'authenticated', 'MEMBER') then
    raise exception 'Test selhal: role % nemůže přepnout na authenticated', current_user;
  end if;
  perform set_config('lock_timeout', c_lock_timeout, true);
  v_already := to_regprocedure('public.my_ws_ids()') is not null;
  v_tm_old := array_fill(null::numeric, array[3 * v_nq]);
  v_tm_new := array_fill(null::numeric, array[3 * v_nq]);
  v_rewritten := array(
    select m[2] || '.' || m[1]
      from regexp_matches(c_ddl_policies, 'create policy (\w+) on public\.(\w+)', 'g') as m);
  select 'lock table ' || string_agg(distinct format('public.%I', m[1]), ', ')
         || ' in access exclusive mode'
    into v_lock_sql
    from regexp_matches(c_ddl_policies, 'create policy \w+ on public\.(\w+)', 'g') as m;

  -- ============================================================ 1) co se měří
  -- Na tabulku jeden dotaz → text[]: otisk viditelných řádků + otisk řádků,
  -- které projdou výrazem každé přepisované UPDATE/DELETE politiky.
  foreach v_t in array c_tables loop
    continue when to_regclass(format('public.%I', v_t)) is null;
    v_pk := null;
    select string_agg(format('%I::text', a.attname), ' || ''|'' || ' order by k.ord)
      into v_pk
      from pg_index ix
      cross join lateral unnest(ix.indkey::int2[]) with ordinality as k(attnum, ord)
      join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = k.attnum
     where ix.indrelid = format('public.%I', v_t)::regclass
       and ix.indisprimary;
    if v_pk is null then
      raise exception 'Test selhal: public.% nemá primární klíč', v_t;
    end if;
    v_tables := v_tables || v_t;
    v_pks := v_pks || v_pk;
    v_parts := v_parts || v_t;
    v_cols := format('(%s) as k', v_pk);
    v_aggs := format(c_agg, '');
    v_n := 0;
    if c_write_checks then
      for r_pol in
        select p.policyname::text as pname, p.qual, p.with_check
          from pg_policies p
         where p.schemaname = 'public'
           and p.tablename::text = v_t
           and p.cmd <> 'SELECT'
           and (p.tablename::text || '.' || p.policyname::text) = any (v_rewritten)
         order by p.policyname
      loop
        foreach v_kind in array array['using', 'check'] loop
          v_expr := case v_kind when 'using' then r_pol.qual else r_pol.with_check end;
          continue when v_expr is null;
          v_n := v_n + 1;
          v_pol_tab := v_pol_tab || v_t;
          v_pol_name := v_pol_name || r_pol.pname;
          v_pol_kind := v_pol_kind || v_kind;
          v_parts := v_parts || format('%s[%s.%s]', v_t, r_pol.pname, v_kind);
          v_cols := v_cols || format(', (%s) as e%s', v_expr, v_n);
          v_aggs := v_aggs || ', ' || format(c_agg, format(' filter (where e%s)', v_n));
        end loop;
      end loop;
    end if;
    v_sql_old := v_sql_old
      || format('select array[%s] from (select %s from public.%I) s', v_aggs, v_cols, v_t);
  end loop;

  -- politiky před změnou: struktura (název, příkaz, role, using/check) a text
  select coalesce(array_agg(format('%s.%s %s %s %s using=%s check=%s',
             p.tablename, p.policyname, p.cmd, p.permissive, p.roles,
             p.qual is not null, p.with_check is not null)
           order by p.tablename, p.policyname), '{}'),
         coalesce(array_agg(format('%s.%s %s', p.tablename, p.policyname,
             md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')))
           order by p.tablename, p.policyname), '{}')
    into v_struct_old, v_expr_old
    from pg_policies p
   where p.schemaname = 'public' and p.tablename::text = any (v_tables);

  -- ============================================================ 2) helpery z 0047
  -- jen v této transakci; tabulky nezamyká
  execute c_ddl_functions;

  -- ============================================================ 3) uživatelé
  select p.id into v_sa
    from public.profiles p
   where p.is_super_admin
   order by p.id
   limit 1;
  select m.user_id into v_admin
    from public.workspace_members m
    join public.profiles p on p.id = m.user_id
   where m.role = 'admin' and not p.is_super_admin
   order by (select count(*) from public.tasks t where t.workspace_id = m.workspace_id) desc,
            m.user_id
   limit 1;
  select m.user_id into v_member
    from public.workspace_members m
    join public.profiles p on p.id = m.user_id
   where not p.is_super_admin
     and not exists (select 1 from public.workspace_members a
                      where a.user_id = m.user_id and a.role = 'admin')
   group by m.user_id
   order by (select count(*) from public.project_members pm where pm.user_id = m.user_id) desc,
            m.user_id
   limit 1;
  if v_admin is not null then
    v_samples := v_samples || v_admin;
    v_sroles := v_sroles || 'admin'::text;
  end if;
  if v_member is not null then
    v_samples := v_samples || v_member;
    v_sroles := v_sroles || 'člen'::text;
  end if;
  if v_sa is not null then
    v_samples := v_samples || v_sa;
    v_sroles := v_sroles || 'super-admin'::text;
  end if;
  -- nepřihlášený (null), vzoroví, pak ostatní podle id
  v_users := array[null::uuid] || v_samples || array(
    select p.id from public.profiles p
     where not (p.id = any (v_samples))
     order by p.id
     limit greatest(c_max_users - cardinality(v_samples), 0));

  -- ============================================================ 4) před / po
  <<users>>
  foreach v_uid in array v_users loop
    v_sidx := coalesce(array_position(v_samples, v_uid), 0);
    if v_uid is not null and v_sidx = 0
       and clock_timestamp() - v_start > c_time_budget then
      v_cut := true;
      exit users;
    end if;
    v_ulabel := coalesce(left(v_uid::text, 8), 'nepřihlášený')
      || case when v_sidx > 0 then ' ' || v_sroles[v_sidx] else '' end;
    v_claims := case when v_uid is null
      then json_build_object('role', 'authenticated')::text
      else json_build_object('sub', v_uid, 'role', 'authenticated')::text end;
    if v_uid is not null then
      v_nusers := v_nusers + 1;
    end if;

    -- 4a) staré helpery ≡ nové množiny přes všechny řádky (jako vlastník, bez RLS)
    v_ctx := 'helpery / ' || v_ulabel;
    perform set_config('request.jwt.claim.sub', coalesce(v_uid::text, ''), true);
    perform set_config('request.jwt.claims', v_claims, true);
    select (select count(*) from public.workspaces w
             where public.is_ws_member(w.id) is distinct from
                     ((select public.is_super_admin()) or w.id = any ((select public.my_ws_ids())::uuid[]))
                or public.is_ws_admin(w.id) is distinct from
                     ((select public.is_super_admin()) or w.id = any ((select public.my_admin_ws_ids())::uuid[])))
         + (select count(*) from public.projects pr
             where public.is_project_member(pr.id) is distinct from
                     (pr.id = any ((select public.my_project_ids())::uuid[])))
         + (select count(*) from public.profiles x
             where public.shares_workspace(x.id) is distinct from
                     (x.id = any ((select public.my_co_member_ids())::uuid[])))
         + (select count(*) from public.hr_grants g
             join public.workspace_members wm
               on wm.workspace_id = g.workspace_id and wm.user_id = g.user_id
             where g.user_id = auth.uid() and wm.can_hr
               and not (g.target_id = any ((select public.my_hr_target_ids())::uuid[])))
      into v_n;
    if v_n > 0 then
      v_ndiff := v_ndiff + v_n;
      if cardinality(v_lines) < c_max_lines then
        v_lines := v_lines || format('helpery / %s: %s neshod starých funkcí s novými množinami',
                                     v_ulabel, v_n);
      end if;
    end if;

    -- 4b) otisky: krok 1 = před, 2 = po (0047 v podtransakci), 3 = znovu před
    v_timed_old := false;
    v_timed_new := false;
    v_step := 1;
    v_round := 0;
    v_state := null;
    while v_state is null loop
      v_mode := case when v_step = 2 then 2 else 1 end;
      v_ok := false;
      for v_try in 1..c_lock_tries loop
        begin
          if v_mode = 2 then
            v_ctx := 'nasazení 0047 / ' || v_ulabel;
            execute v_lock_sql;
            v_t_lock := clock_timestamp();
            execute c_ddl_policies;
            if v_sql_new is null then
              -- dotazy s výrazy nových politik (stejné pořadí otisků jako před)
              v_sql_tmp := '{}';
              v_j := 0;
              for v_i in 1..cardinality(v_tables) loop
                v_t := v_tables[v_i];
                v_cols := format('(%s) as k', v_pks[v_i]);
                v_aggs := format(c_agg, '');
                v_n := 0;
                while v_j < cardinality(v_pol_tab) and v_pol_tab[v_j + 1] = v_t loop
                  v_j := v_j + 1;
                  v_expr := null;
                  select case v_pol_kind[v_j] when 'using' then p.qual else p.with_check end
                    into v_expr
                    from pg_policies p
                   where p.schemaname = 'public'
                     and p.tablename::text = v_t
                     and p.policyname::text = v_pol_name[v_j];
                  v_n := v_n + 1;
                  v_cols := v_cols || format(', (%s) as e%s', coalesce(v_expr, 'null::boolean'), v_n);
                  v_aggs := v_aggs || ', ' || format(c_agg, format(' filter (where e%s)', v_n));
                end loop;
                v_sql_tmp := v_sql_tmp
                  || format('select array[%s] from (select %s from public.%I) s', v_aggs, v_cols, v_t);
              end loop;
              select coalesce(array_agg(format('%s.%s %s %s %s using=%s check=%s',
                         p.tablename, p.policyname, p.cmd, p.permissive, p.roles,
                         p.qual is not null, p.with_check is not null)
                       order by p.tablename, p.policyname), '{}'),
                     coalesce(array_agg(format('%s.%s %s', p.tablename, p.policyname,
                         md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, '')))
                       order by p.tablename, p.policyname), '{}')
                into v_struct_new, v_expr_new
                from pg_policies p
               where p.schemaname = 'public' and p.tablename::text = any (v_tables);
              v_sql_new := v_sql_tmp;
            end if;
          end if;

          -- jako přihlášený uživatel (DDL výš běželo jako vlastník)
          execute 'set local role authenticated';
          perform set_config('request.jwt.claim.sub', coalesce(v_uid::text, ''), true);
          perform set_config('request.jwt.claims', v_claims, true);
          v_cur := '{}';
          for v_i in 1..cardinality(v_tables) loop
            v_ctx := format('%s / %s / %s',
                            case v_mode when 1 then 'před' else 'po' end, v_tables[v_i], v_ulabel);
            execute case v_mode when 1 then v_sql_old[v_i] else v_sql_new[v_i] end into v_arr;
            v_cur := v_cur || v_arr;
          end loop;

          -- časy vzorových uživatelů (jednou před, jednou po)
          if v_sidx > 0 and not (case v_mode when 1 then v_timed_old else v_timed_new end) then
            for v_q in 1..v_nq loop
              v_ctx := format('měření / %s / %s', c_queries[v_q], v_ulabel);
              v_best := null;
              for v_r in 1..c_runs loop
                v_t0 := clock_timestamp();
                execute c_queries[v_q] into v_dummy;
                v_best := least(v_best, extract(epoch from clock_timestamp() - v_t0)::numeric * 1000);
              end loop;
              if v_mode = 1 then
                v_tm_old[(v_sidx - 1) * v_nq + v_q] := v_best;
              else
                v_tm_new[(v_sidx - 1) * v_nq + v_q] := v_best;
              end if;
            end loop;
            if v_mode = 1 then
              v_timed_old := true;
            else
              v_timed_new := true;
            end if;
          end if;

          execute 'reset role';
          if v_mode = 2 then
            v_lock_max := greatest(v_lock_max,
                                   extract(epoch from clock_timestamp() - v_t_lock)::numeric * 1000);
          end if;
          -- odvolat podtransakci: politiky 0047, zámky, roli i JWT (proměnné zůstanou)
          raise exception using errcode = 'KR047', message = '0047 test: odvolání podtransakce';
        exception
          when sqlstate 'KR047' then
            v_ok := true;
          when lock_not_available or deadlock_detected then
            v_ok := false;
          when others then
            raise exception 'Test selhal (%): % [%]', v_ctx, sqlerrm, sqlstate;
        end;
        exit when v_ok;
        perform pg_sleep(0.2);
      end loop;
      if not v_ok then
        raise exception 'Test selhal: zámky tabulek se nepodařilo získat ani na % pokusů (%) — pusť znovu mimo špičku.',
          c_lock_tries, v_ctx;
      end if;

      if v_step = 1 then
        v_old := v_cur;
        v_step := 2;
      elsif v_step = 2 then
        v_new := v_cur;
        if v_new = v_old then
          v_state := 'ok';
        else
          v_step := 3;
        end if;
      else
        -- „před" znovu: stejné → rozdíl je v politikách; jiné → měnila se data
        v_round := v_round + 1;
        if v_cur = v_old then
          v_state := 'diff';
        elsif v_round >= 3 then
          v_old := v_cur;
          v_state := 'unstable';
        else
          v_old := v_cur;
          v_step := 2;
        end if;
      end if;
    end loop;

    if v_state <> 'ok' then
      for v_i in 1..greatest(cardinality(v_old), cardinality(v_new)) loop
        continue when v_old[v_i] is not distinct from v_new[v_i];
        v_ndiff := v_ndiff + 1;
        if cardinality(v_lines) < c_max_lines then
          v_lines := v_lines || format('%s / %s: před %s → po %s%s%s',
            coalesce(v_parts[v_i], '?'), v_ulabel,
            coalesce(split_part(v_old[v_i], ':', 1), '-'),
            coalesce(split_part(v_new[v_i], ':', 1), '-'),
            case when split_part(v_old[v_i], ':', 1) = split_part(v_new[v_i], ':', 1)
                 then ' (stejný počet, jiné řádky)' else '' end,
            case when v_state = 'unstable'
                 then ' (data se během měření měnila — pusť znovu)' else '' end);
        end if;
      end loop;
    end if;
  end loop users;

  -- ============================================================ 5) struktura politik
  if v_struct_new is null then
    raise exception 'Test selhal: politiky 0047 se nepodařilo nasadit ani jednou';
  end if;
  for v_x in select s from unnest(v_struct_old) as s where not (s = any (v_struct_new)) loop
    v_ndiff := v_ndiff + 1;
    if cardinality(v_slines) < c_max_lines then
      v_slines := v_slines || ('politika před 0047, po ní chybí/liší se: ' || v_x);
    end if;
  end loop;
  for v_x in select s from unnest(v_struct_new) as s where not (s = any (v_struct_old)) loop
    v_ndiff := v_ndiff + 1;
    if cardinality(v_slines) < c_max_lines then
      v_slines := v_slines || ('politika po 0047 navíc/liší se: ' || v_x);
    end if;
  end loop;
  select count(*) into v_changed
    from unnest(v_expr_new) as s
   where not (s = any (v_expr_old));

  -- ============================================================ 6) výsledek
  v_lines := v_slines || v_lines;
  v_report := case
      when v_ndiff > 0 then format('ROZDÍLY: %s', v_ndiff)
      when v_cut then format('NEÚPLNÉ — bez rozdílu, ale jen %s z %s uživatelů (vypršel c_time_budget)',
                             v_nusers, cardinality(v_users) - 1)
      else 'OK — žádný rozdíl' end;
  if v_already then
    v_report := v_report || ' · POZOR: 0047 už je nasazená (my_ws_ids existuje) — test porovnal'
      || ' 0047 samu se sebou a nic neověřil; pusť 0047_rls_porovnani_po.sql';
  end if;
  v_report := v_report || chr(10) || format(
      'uživatelů %s + nepřihlášený · tabulek %s · otisků na uživatele %s · politik v 0047 %s (změněný výraz %s) · %s s · nejdelší zámek tabulek %s ms',
      v_nusers, cardinality(v_tables), cardinality(v_parts), cardinality(v_rewritten), v_changed,
      round(extract(epoch from clock_timestamp() - v_start)::numeric, 1), round(v_lock_max));
  for v_i in 1..least(cardinality(v_lines), c_max_lines) loop
    v_report := v_report || chr(10) || v_lines[v_i];
  end loop;
  if v_ndiff > least(cardinality(v_lines), c_max_lines) then
    v_report := v_report || chr(10) || format('… (výpis zkrácen, rozdílů celkem %s)', v_ndiff);
  end if;
  v_report := v_report || chr(10)
    || format('Časy jako role authenticated (nejlepší z %s běhů):', c_runs);
  if cardinality(v_samples) = 0 then
    v_report := v_report || chr(10) || '(žádný vzorový uživatel)';
  end if;
  for v_i in 1..cardinality(v_samples) loop
    for v_q in 1..v_nq loop
      v_report := v_report || chr(10) || format('%s (%s %s): před %s ms → po %s ms',
        replace(c_queries[v_q], 'select count(*) from public.', 'count '),
        v_sroles[v_i], left(v_samples[v_i]::text, 8),
        coalesce(round(v_tm_old[(v_i - 1) * v_nq + v_q], 1)::text, '?'),
        coalesce(round(v_tm_new[(v_i - 1) * v_nq + v_q], 1)::text, '?'));
    end loop;
  end loop;
  v_report := v_report || chr(10)
    || '(Chyba je záměr: raise exception vrátil vše zpět, v databázi nic nezůstalo.)';
  raise exception '%', v_report;
end
$$;
