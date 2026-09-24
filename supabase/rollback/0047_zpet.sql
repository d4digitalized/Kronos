-- Návrat migrace 0047_rls_vykon.sql (DOWN): obnoví PŘESNĚ stav před 0047.
-- Každá politika, kterou 0047 přepsala, dostane zpět svou poslední platnou
-- definici — doslovný text z původní migrace (soubor:řádek nad ní). Nakonec
-- se smažou helpery my_*_ids z 0047; až po politikách, protože politiky
-- z 0047 na nich závisí. Funguje, ať je 0047 nasazená, nebo ne (if exists).
--
-- Ověření: supabase/tests/0047_rls_porovnani_po.sql — porovná současný stav
-- se stavem po tomhle návratu (v transakci, kterou odvolá). Úsek mezi
-- značkami >>> / <<< má test doslova zkopírovaný — při změně upravit oba.

begin;

-- >>> 0047:zpet
-- ================================================================ profiles

-- 0001_init.sql:132
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select
  using (id = auth.uid() or public.is_super_admin() or public.shares_workspace(id));

-- 0010_avatars.sql:22
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update
  using (id = auth.uid() or public.admin_shares_workspace(id))
  with check (id = auth.uid() or public.admin_shares_workspace(id));

-- ================================================================ workspaces

-- 0001_init.sql:142
drop policy if exists workspaces_select on public.workspaces;
create policy workspaces_select on public.workspaces for select
  using (public.is_ws_member(id));

-- 0001_init.sql:146
drop policy if exists workspaces_update on public.workspaces;
create policy workspaces_update on public.workspaces for update
  using (public.is_super_admin());

-- 0001_init.sql:148
drop policy if exists workspaces_delete on public.workspaces;
create policy workspaces_delete on public.workspaces for delete
  using (public.is_super_admin());

-- ================================================================ workspace_members

-- 0001_init.sql:153
drop policy if exists members_select on public.workspace_members;
create policy members_select on public.workspace_members for select
  using (public.is_ws_member(workspace_id));

-- 0001_init.sql:158
drop policy if exists members_update on public.workspace_members;
create policy members_update on public.workspace_members for update
  using (public.is_super_admin());

-- 0001_init.sql:160
drop policy if exists members_delete on public.workspace_members;
create policy members_delete on public.workspace_members for delete
  using (public.is_super_admin()
    or (public.is_ws_admin(workspace_id) and role = 'member')
    or user_id = auth.uid());

-- ================================================================ projects

-- 0004_project_members.sql:58
drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects for select
  using (public.is_ws_admin(workspace_id) or public.is_project_member(id));

-- 0001_init.sql:170
drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects for update
  using (public.is_ws_admin(workspace_id));

-- 0001_init.sql:172
drop policy if exists projects_delete on public.projects;
create policy projects_delete on public.projects for delete
  using (public.is_ws_admin(workspace_id));

-- ================================================================ project_members

-- 0004_project_members.sql:50
drop policy if exists pm_delete on public.project_members;
create policy pm_delete on public.project_members for delete
  using (exists (select 1 from public.projects p
                 where p.id = project_id and public.is_ws_admin(p.workspace_id)));

-- ================================================================ board_columns

-- 0004_project_members.sql:88
drop policy if exists columns_select on public.board_columns;
create policy columns_select on public.board_columns for select
  using (public.is_ws_admin(workspace_id) or public.is_project_member(project_id));

-- 0004_project_members.sql:98
drop policy if exists columns_update on public.board_columns;
create policy columns_update on public.board_columns for update
  using (public.is_ws_admin(workspace_id) or public.is_project_member(project_id));

-- 0004_project_members.sql:102
drop policy if exists columns_delete on public.board_columns;
create policy columns_delete on public.board_columns for delete
  using (public.is_ws_admin(workspace_id) or public.is_project_member(project_id));

-- ================================================================ tasks

-- 0040_oprava_insert_returning.sql:9
drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks for select
  using (
    (not is_private or created_by = auth.uid())
    and (
      public.is_ws_admin(workspace_id)
      or lead_id = auth.uid()
      or (project_id is not null and public.is_project_member(project_id)
          and (created_by = auth.uid() -- přímo na řádce: drží i INSERT ... RETURNING
               or public.is_task_mine(id)
               or (parent_id is not null and public.is_task_mine(parent_id))))
      or (project_id is null and public.is_ws_member(workspace_id)
          and (created_by = auth.uid() or public.is_task_assignee(id)))
    )
  );

-- 0040_oprava_insert_returning.sql:25
drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update
  using (
    (not is_private or created_by = auth.uid())
    and (
      public.is_ws_admin(workspace_id)
      or lead_id = auth.uid()
      or (project_id is not null and public.is_project_member(project_id)
          and (created_by = auth.uid()
               or public.is_task_mine(id)
               or (parent_id is not null and public.is_task_mine(parent_id))))
      or (project_id is null and public.is_ws_member(workspace_id)
          and (created_by = auth.uid() or public.is_task_assignee(id)))
    )
  )
  with check (
    (not is_private or created_by = auth.uid())
    and (
      (project_id is not null
        and (public.is_ws_admin(workspace_id)
             or public.is_project_member(project_id)
             or lead_id = auth.uid())
        and exists (select 1 from public.projects p
                    where p.id = project_id and p.workspace_id = tasks.workspace_id)
        and (column_id is null or exists
          (select 1 from public.board_columns c
           where c.id = column_id and c.project_id = tasks.project_id)))
      or (project_id is null
        and (public.is_ws_member(workspace_id) or lead_id = auth.uid())
        and column_id is null)
    )
  );

-- 0001_init.sql:188
drop policy if exists tasks_delete on public.tasks;
create policy tasks_delete on public.tasks for delete
  using (created_by = auth.uid() or public.is_ws_admin(workspace_id));

-- ================================================================ task_assignees

-- 0017_assign_grants.sql:44
drop policy if exists ta_delete on public.task_assignees;
create policy ta_delete on public.task_assignees for delete
  using (user_id = auth.uid()
    or exists (select 1 from public.tasks t
               where t.id = task_assignees.task_id
                 and (public.is_ws_admin(t.workspace_id)
                   or exists (select 1 from public.assign_grants g
                              where g.workspace_id = t.workspace_id
                                and g.user_id = auth.uid()
                                and g.target_id = task_assignees.user_id))));

-- ================================================================ time_entries

-- 0026_hr_vykazy.sql:34
drop policy if exists entries_select on public.time_entries;
create policy entries_select on public.time_entries for select
  using (
    user_id = auth.uid()
    or public.is_ws_admin(workspace_id)
    or exists (
      select 1
      from public.hr_grants g
      join public.workspace_members wm
        on wm.workspace_id = g.workspace_id and wm.user_id = g.user_id
      where g.workspace_id = time_entries.workspace_id
        and g.user_id = auth.uid()
        and g.target_id = time_entries.user_id
        and wm.can_hr
    )
  );

-- 0043_hr_upravy_vykazu.sql:6
drop policy if exists entries_update on public.time_entries;
create policy entries_update on public.time_entries for update
  using (
    user_id = auth.uid()
    or public.is_ws_admin(workspace_id)
    or exists (
      select 1
      from public.hr_grants g
      join public.workspace_members wm
        on wm.workspace_id = g.workspace_id and wm.user_id = g.user_id
      where g.workspace_id = time_entries.workspace_id
        and g.user_id = auth.uid()
        and g.target_id = time_entries.user_id
        and wm.can_hr
    )
  );

-- 0001_init.sql:201
drop policy if exists entries_delete on public.time_entries;
create policy entries_delete on public.time_entries for delete
  using (user_id = auth.uid() or public.is_ws_admin(workspace_id));

-- ================================================================ task_comments

-- 0004_project_members.sql:107
drop policy if exists comments_select on public.task_comments;
create policy comments_select on public.task_comments for select
  using (public.is_ws_member(workspace_id)
    and exists (select 1 from public.tasks t where t.id = task_id));

-- 0002_kanban.sql:78
drop policy if exists comments_update on public.task_comments;
create policy comments_update on public.task_comments for update
  using (author_id = auth.uid());

-- 0002_kanban.sql:80
drop policy if exists comments_delete on public.task_comments;
create policy comments_delete on public.task_comments for delete
  using (author_id = auth.uid() or public.is_ws_admin(workspace_id));

-- ================================================================ task_attachments

-- 0018_task_attachments.sql:45
drop policy if exists task_attachments_delete on public.task_attachments;
create policy task_attachments_delete on public.task_attachments for delete
  using (uploaded_by = auth.uid() or public.is_ws_admin(workspace_id));

-- ================================================================ task_followups

-- 0037_cekam_od_do.sql:15
drop policy if exists task_followups_update on public.task_followups;
create policy task_followups_update on public.task_followups for update
  using (created_by = auth.uid() or public.is_ws_admin(workspace_id))
  with check (created_by = auth.uid() or public.is_ws_admin(workspace_id));

-- ================================================================ labels

-- 0005_priority_labels.sql:32
drop policy if exists labels_select on public.labels;
create policy labels_select on public.labels for select
  using (public.is_ws_member(workspace_id));

-- 0005_priority_labels.sql:36
drop policy if exists labels_update on public.labels;
create policy labels_update on public.labels for update
  using (public.is_ws_member(workspace_id));

-- 0005_priority_labels.sql:38
drop policy if exists labels_delete on public.labels;
create policy labels_delete on public.labels for delete
  using (public.is_ws_admin(workspace_id));

-- ================================================================ contacts

-- 0021_delegace.sql:43
drop policy if exists contacts_select on public.contacts;
create policy contacts_select on public.contacts for select
  using (public.is_ws_member(workspace_id));

-- 0021_delegace.sql:47
drop policy if exists contacts_update on public.contacts;
create policy contacts_update on public.contacts for update
  using (public.is_ws_member(workspace_id));

-- 0021_delegace.sql:49
drop policy if exists contacts_delete on public.contacts;
create policy contacts_delete on public.contacts for delete
  using (public.is_ws_admin(workspace_id));

-- ================================================================ assign_grants

-- 0017_assign_grants.sql:15
drop policy if exists grants_select on public.assign_grants;
create policy grants_select on public.assign_grants for select
  using (public.is_ws_member(workspace_id));

-- 0017_assign_grants.sql:19
drop policy if exists grants_delete on public.assign_grants;
create policy grants_delete on public.assign_grants for delete
  using (public.is_ws_admin(workspace_id));

-- ================================================================ hr_grants

-- 0026_hr_vykazy.sql:22
drop policy if exists hr_grants_select on public.hr_grants;
create policy hr_grants_select on public.hr_grants for select
  using (public.is_ws_member(workspace_id));

-- 0026_hr_vykazy.sql:26
drop policy if exists hr_grants_delete on public.hr_grants;
create policy hr_grants_delete on public.hr_grants for delete
  using (public.is_ws_admin(workspace_id));

-- ================================================================ project_categories

-- 0036_kategorie_projektu.sql:20
drop policy if exists project_categories_select on public.project_categories;
create policy project_categories_select on public.project_categories for select
  using (public.is_ws_member(workspace_id));

-- 0036_kategorie_projektu.sql:24
drop policy if exists project_categories_update on public.project_categories;
create policy project_categories_update on public.project_categories for update
  using (public.is_ws_admin(workspace_id));

-- 0036_kategorie_projektu.sql:26
drop policy if exists project_categories_delete on public.project_categories;
create policy project_categories_delete on public.project_categories for delete
  using (public.is_ws_admin(workspace_id));

-- ================================================================ notifications

-- 0009_notifications_inapp.sql:11
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select
  using (user_id = auth.uid());

-- 0009_notifications_inapp.sql:13
drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ================================================================ task_priority

-- 0031_priority_list.sql:18
drop policy if exists task_priority_select on public.task_priority;
create policy task_priority_select on public.task_priority for select
  using (user_id = auth.uid());

-- 0031_priority_list.sql:22
drop policy if exists task_priority_update on public.task_priority;
create policy task_priority_update on public.task_priority for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 0031_priority_list.sql:24
drop policy if exists task_priority_delete on public.task_priority;
create policy task_priority_delete on public.task_priority for delete
  using (user_id = auth.uid());

-- ================================================================ helpery z 0047
-- až po politikách: nové politiky na nich závisely (pg_depend)
drop function if exists public.my_ws_ids();
drop function if exists public.my_admin_ws_ids();
drop function if exists public.my_project_ids();
drop function if exists public.my_co_member_ids();
drop function if exists public.my_hr_target_ids();
-- <<< 0047:zpet

commit;
