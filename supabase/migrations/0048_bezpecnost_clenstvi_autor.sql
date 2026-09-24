-- 0048: tři díry nalezené při přepisu RLS (0047), viz docs/AUDIT-2026-09-24.md §5.3.
--
-- 1) Odebraný člen firmy dál viděl projekty, na kterých byl: při odebrání
--    z firmy zůstaly jeho řádky v project_members a politiky projektů /
--    sloupců / úkolů se ptají jen na ně. Do aplikace se nedostal, ale přes
--    API (i MCP) projekty a úkoly dál četl a mohl v nich zakládat úkoly.
--    → při odebrání z firmy (i při odchodu sám) se smaže jeho členství
--      v projektech té firmy; k tomu jednorázový úklid starých případů.
-- 2) Kdo smí úkol upravit, mohl přepsat created_by na sebe — pak ho smí
--    smazat nebo skrýt (is_private) i před adminy. → změnu autora odmítnout.
-- 3) UPDATE politiky time_entries, task_comments, checklists, board_columns
--    a task_followups nehlídaly, kam řádek patří: vlastní záznam času či
--    komentář šel přesunout do cizí firmy nebo k cizímu úkolu.
--    → přesun mezi firmami / úkoly odmítnout; projekt a úkol záznamu času
--      musí patřit do jeho firmy.
--
-- Hlídají triggery, ne politiky: RLS (a tedy kdo co vidí) zůstává beze změny
-- a stávající záznamy jdou dál upravovat v ostatních polích. Bez přihlášení
-- (SQL editor, service role) triggery 2) a 3) nic neblokují — ruční opravy
-- dat zůstávají možné.
--
-- NEJDŘÍV pustit supabase/tests/0048_kontrola.sql (ukáže, komu úklid vezme
-- přístup, a vyzkouší triggery na skutečných datech — vše vrátí zpět).
-- Úsek mezi značkami >>> / <<< má test doslova zkopírovaný.

begin;

-- >>> 0048:ddl
-- ------------------------------------------------------------------ 1) členství
create or replace function public.drop_project_memberships_on_ws_leave()
returns trigger language plpgsql security definer set search_path = public
as $fn$
begin
  delete from public.project_members pm
   using public.projects p
   where p.id = pm.project_id
     and p.workspace_id = old.workspace_id
     and pm.user_id = old.user_id;
  return old;
end;
$fn$;

drop trigger if exists after_ws_member_delete_projects on public.workspace_members;
create trigger after_ws_member_delete_projects
  after delete on public.workspace_members
  for each row execute function public.drop_project_memberships_on_ws_leave();

-- ------------------------------------------------------------------ 2) autor úkolu
create or replace function public.keep_task_author()
returns trigger language plpgsql set search_path = public
as $fn$
begin
  if auth.uid() is not null and new.created_by is distinct from old.created_by then
    raise exception 'Autora úkolu nelze změnit.' using errcode = '42501';
  end if;
  return new;
end;
$fn$;

drop trigger if exists before_task_update_keep_author on public.tasks;
create trigger before_task_update_keep_author
  before update of created_by on public.tasks
  for each row execute function public.keep_task_author();

-- ------------------------------------------------------------------ 3) žádné přesuny
-- záznam času: firma pevná; nový projekt / úkol musí být z téže firmy.
-- security definer: kontrola čte projekty a úkoly bez RLS (HR a admin
-- upravují i záznamy v projektech, které sami nevidí).
create or replace function public.guard_time_entry_move()
returns trigger language plpgsql security definer set search_path = public
as $fn$
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.workspace_id is distinct from old.workspace_id then
    raise exception 'Záznam času nelze přesunout do jiné firmy.' using errcode = '42501';
  end if;
  if new.project_id is distinct from old.project_id and new.project_id is not null
     and not exists (select 1 from public.projects p
                      where p.id = new.project_id and p.workspace_id = new.workspace_id) then
    raise exception 'Projekt nepatří do firmy záznamu.' using errcode = '42501';
  end if;
  if new.task_id is distinct from old.task_id and new.task_id is not null
     and not exists (select 1 from public.tasks t
                      where t.id = new.task_id and t.workspace_id = new.workspace_id) then
    raise exception 'Úkol nepatří do firmy záznamu.' using errcode = '42501';
  end if;
  return new;
end;
$fn$;

drop trigger if exists before_time_entry_update_guard on public.time_entries;
create trigger before_time_entry_update_guard
  before update of workspace_id, project_id, task_id on public.time_entries
  for each row execute function public.guard_time_entry_move();

-- komentář, checklist, „Čekám na": patří napořád ke svému úkolu a firmě
create or replace function public.guard_task_child_move()
returns trigger language plpgsql set search_path = public
as $fn$
begin
  if auth.uid() is not null
     and (new.task_id is distinct from old.task_id
          or new.workspace_id is distinct from old.workspace_id) then
    raise exception 'Záznam nelze přesunout k jinému úkolu ani do jiné firmy.'
      using errcode = '42501';
  end if;
  return new;
end;
$fn$;

drop trigger if exists before_comment_update_guard on public.task_comments;
create trigger before_comment_update_guard
  before update of task_id, workspace_id on public.task_comments
  for each row execute function public.guard_task_child_move();

drop trigger if exists before_checklist_update_guard on public.checklists;
create trigger before_checklist_update_guard
  before update of task_id, workspace_id on public.checklists
  for each row execute function public.guard_task_child_move();

drop trigger if exists before_followup_update_guard on public.task_followups;
create trigger before_followup_update_guard
  before update of task_id, workspace_id on public.task_followups
  for each row execute function public.guard_task_child_move();

-- sloupec nástěnky patří napořád ke svému projektu a firmě
create or replace function public.guard_column_move()
returns trigger language plpgsql set search_path = public
as $fn$
begin
  if auth.uid() is not null
     and (new.project_id is distinct from old.project_id
          or new.workspace_id is distinct from old.workspace_id) then
    raise exception 'Sloupec nelze přesunout do jiného projektu ani firmy.'
      using errcode = '42501';
  end if;
  return new;
end;
$fn$;

drop trigger if exists before_column_update_guard on public.board_columns;
create trigger before_column_update_guard
  before update of project_id, workspace_id on public.board_columns
  for each row execute function public.guard_column_move();
-- <<< 0048:ddl

-- >>> 0048:uklid
-- jednorázově: členství v projektech firem, ve kterých člověk už není
delete from public.project_members pm
 using public.projects p
 where p.id = pm.project_id
   and not exists (select 1 from public.workspace_members m
                    where m.workspace_id = p.workspace_id
                      and m.user_id = pm.user_id);
-- <<< 0048:uklid

commit;
