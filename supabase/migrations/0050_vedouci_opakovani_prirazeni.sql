-- 0050: tři chyby z auditu (docs/AUDIT-2026-09-24.md §5.2 a §5.3).
--
-- 1) Vedoucí úkolu, který není členem projektu, úkol neupravil ani
--    nedokončil: with check v tasks_update ověřoval projekt a sloupec přes
--    exists (…) pod RLS — a ta vedoucího k projektu nepustí. 0025 přitom
--    vedoucímu úpravy dovoluje. → kontrola umístění (projekt ve firmě
--    úkolu, sloupec v projektu) přes security definer funkci. Ostatním se
--    nic nemění: kdo smí upravovat, určuje dál první část podmínky.
-- 2) Opakovaný úkol: dokonči → znovu otevři → dokonči = druhá kopie. →
--    příznak recur_spawned; kopie vzniká jen jednou. Trigger je nově
--    BEFORE (příznak se zapíše s dokončením, bez dalšího UPDATE).
--    Staré dokončené opakované úkoly se označí, ať po znovuotevření nerodí.
-- 3) Přiřazení řešitele: politika hlídala jen to, KOHO lze přiřadit (člen
--    projektu / firmy), ne KDO přiřazuje — přes API šlo přiřadit kohokoli,
--    ač aplikace dovoluje admin → komukoli, člen → sobě a lidem, na které
--    má grant (stejně jako mazání řešitelů v ta_delete). → totéž pravidlo
--    i pro vkládání.
--
-- NEJDŘÍV pustit supabase/tests/0050_kontrola.sql (vše na dočasných datech
-- v transakci, která se vrátí). Úsek mezi značkami >>> / <<< má test
-- doslova zkopírovaný.

begin;

-- >>> 0050:ddl
-- ------------------------------------------------------------------ 1) vedoucí
create or replace function public.task_placement_ok(p_project uuid, p_ws uuid, p_column uuid)
returns boolean language sql stable security definer set search_path = public
as $fn$
  select exists (select 1 from public.projects p
                  where p.id = p_project and p.workspace_id = p_ws)
     and (p_column is null
          or exists (select 1 from public.board_columns c
                      where c.id = p_column and c.project_id = p_project))
$fn$;

-- using beze změny (0047); ve with check místo exists pod RLS task_placement_ok
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
        and public.task_placement_ok(project_id, workspace_id, column_id))
      or (project_id is null
        and (((select public.is_super_admin())
              or workspace_id = any ((select public.my_ws_ids())::uuid[]))
             or lead_id = (select auth.uid()))
        and column_id is null)
    )
  );

-- ------------------------------------------------------------------ 2) opakování
alter table public.tasks
  add column if not exists recur_spawned boolean not null default false;

create or replace function public.handle_recurring_task()
returns trigger language plpgsql security definer set search_path = public
as $fn$
declare
  base date;
  next_due date;
  new_id uuid;
begin
  if new.completed_at is not null and old.completed_at is null
     and new.recurrence is not null and new.parent_id is null
     and not new.recur_spawned then
    base := coalesce(new.due_date, current_date);
    next_due := case new.recurrence
      when 'daily' then base + 1
      when 'weekdays' then case extract(isodow from base)::int
        when 5 then base + 3  -- pá → po
        when 6 then base + 2  -- so → po
        else base + 1 end
      when 'weekly' then base + 7
      when 'monthly' then (base + interval '1 month')::date
      when 'yearly' then (base + interval '1 year')::date
    end;

    insert into tasks (workspace_id, project_id, column_id, position, title,
                       description, due_date, created_by, priority, recurrence,
                       is_private)
    values (new.workspace_id, new.project_id, new.column_id, new.position,
            new.title, new.description, next_due, new.created_by,
            new.priority, new.recurrence, new.is_private)
    returning id into new_id;

    insert into task_labels (task_id, label_id)
    select new_id, label_id from task_labels where task_id = new.id;

    insert into task_assignees (task_id, user_id)
    select new_id, user_id from task_assignees where task_id = new.id;

    insert into task_contact_assignees (task_id, contact_id)
    select new_id, contact_id from task_contact_assignees where task_id = new.id;

    -- kopie je venku — znovuotevření a nové dokončení už další nevytvoří
    new.recur_spawned := true;
  end if;
  return new;
end;
$fn$;

drop trigger if exists on_task_completed_recur on public.tasks;
drop trigger if exists before_task_completed_recur on public.tasks;
create trigger before_task_completed_recur
  before update on public.tasks
  for each row execute function public.handle_recurring_task();

-- ------------------------------------------------------------------ 3) přiřazení
-- kdo přiřazuje: admin (i super-admin) komukoli, člen sobě a lidem, na
-- které má grant; koho lze přiřadit: beze změny (0023)
drop policy if exists ta_insert on public.task_assignees;
create policy ta_insert on public.task_assignees for insert
  with check (
    (user_id = (select auth.uid())
     or exists (select 1 from public.tasks t
                 where t.id = task_assignees.task_id
                   and ((select public.is_super_admin())
                        or t.workspace_id = any ((select public.my_admin_ws_ids())::uuid[])
                        or exists (select 1 from public.assign_grants g
                                    where g.workspace_id = t.workspace_id
                                      and g.user_id = (select auth.uid())
                                      and g.target_id = task_assignees.user_id))))
    and exists (
      select 1 from public.tasks t
      where t.id = task_assignees.task_id
        and (
          (t.project_id is not null and (
            exists (select 1 from public.project_members pm
                    where pm.project_id = t.project_id
                      and pm.user_id = task_assignees.user_id)
            or exists (select 1 from public.workspace_members wm
                       where wm.workspace_id = t.workspace_id
                         and wm.user_id = task_assignees.user_id
                         and wm.role = 'admin')))
          or (t.project_id is null and exists (
            select 1 from public.workspace_members wm
            where wm.workspace_id = t.workspace_id
              and wm.user_id = task_assignees.user_id))
        ))
  );
-- <<< 0050:ddl

-- >>> 0050:data
-- staré dokončené opakované úkoly svou kopii už mají — po znovuotevření
-- a dokončení se nesmí vytvořit druhá
update public.tasks set recur_spawned = true
 where recurrence is not null and completed_at is not null and not recur_spawned;
-- <<< 0050:data

commit;
