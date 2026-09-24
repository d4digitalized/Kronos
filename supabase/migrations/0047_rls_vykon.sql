-- 0047: RLS výkon. Politiky už nevolají security-definer funkce pro každý
-- řádek. Práva zůstávají PŘESNĚ stejná: stejné názvy, příkazy, rozdělení
-- USING / WITH CHECK i logika — mění se jen způsob vyhodnocení.
-- Viz docs/AUDIT-2026-09-24.md §5.2.
--
-- Dřív: is_ws_admin(workspace_id), is_project_member(project_id) … dostávaly
-- argument z řádku → volaly se pro každý řádek (is_ws_* navíc volá
-- is_super_admin()) a auth.uid() se počítalo pro každý řádek.
-- Teď: helpery vrací pole id přihlášeného a politika je volá jako (select …)
-- → initPlan, jednou na dotaz; na řádek zbude porovnání s polem.
--
-- Záměny 1:1 (argumenty nejsou NULL, nebo je hlídá „is not null" před nimi):
--   auth.uid()           → (select auth.uid())
--   is_super_admin()     → (select public.is_super_admin())
--   is_ws_member(x)      → (select public.is_super_admin()) or x = any ((select public.my_ws_ids())::uuid[])
--   is_ws_admin(x)       → (select public.is_super_admin()) or x = any ((select public.my_admin_ws_ids())::uuid[])
--   is_project_member(x) → x = any ((select public.my_project_ids())::uuid[])
--   shares_workspace(x)  → x = any ((select public.my_co_member_ids())::uuid[])
-- Cast ::uuid[] uvnitř any(…) je NUTNÝ: bez něj parser bere dvojité závorky
-- jako poddotaz ANY a politika padá na 42883 „operator does not exist:
-- uuid = uuid[]". S castem je to skalární poddotaz → pole → initPlan.
-- is_task_mine, is_task_assignee a admin_shares_workspace zůstávají per řádek
-- (is_task_mine čte snímek tasks — viz 0040), volají se až za levnými testy.
-- Jediná přidaná podmínka je v entries_select (viz tam, je to jen předfiltr).
--
-- Beze změny zůstávají INSERT politiky (1× na vkládaný řádek) a politiky,
-- které jen testují exists (… tasks / projects …): ta_select, pm_select,
-- task_labels_*, checklists_*, checklist_items_*, task_activity_select,
-- tca_*, task_followups_select/delete, task_attachments_select — zrychlí se
-- samy přes rychlejší tasks_select / projects_select.
--
-- NEJDŘÍV pustit supabase/tests/0047_rls_porovnani.sql a nasadit jen když
-- vrátí „OK — žádný rozdíl". Úseky mezi značkami >>> / <<< má test doslova
-- zkopírované — při změně upravit oba soubory. Těla funkcí proto mají
-- $fn$ místo obvyklého dvojitého dolaru (test je jeden blok do).

begin;

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

commit;
