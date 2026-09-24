-- ============================================================================
-- Kontrola migrace 0048_bezpecnost_clenstvi_autor.sql — na PRODUKCI, PŘED
-- nasazením i PO něm.
--
-- !!! CHYBA NA KONCI JE ZÁMĚR — VRACÍ VŠE ZPĚT !!!
-- Skript je jediný blok „do" a končí raise exception, jehož text je výsledek.
-- Tím PostgreSQL odvolá celou transakci: když 0048 ještě není nasazená, test
-- si ji jen dočasně nasadí; zkušební úpravy dat se vrátí. V DB nic nezůstane.
--
-- Jak: Supabase → SQL Editor jako postgres, vložit CELÝ soubor, Run.
--
-- Výsledek (první řádek): „OK" / „CHYBY: N" · stav 0048 (nasazená / zkoušená
-- dočasně). Pod tím:
--   úklid: … — koho jednorázový úklid odpojí od projektů firmy, ve které už
--            není (po nasazení 0048 má být prázdné),
--   test:  … — zkoušky jako skutečný uživatel (role authenticated s jeho JWT):
--            ✓ správně zablokováno / správně prošlo, ✗ chyba, – chybí data.
--
-- Úseky mezi značkami >>> 0048:ddl / <<< a >>> 0048:uklid / <<< jsou DOSLOVA
-- z migrace (generuje je skript; při změně migrace vygenerovat znovu).
-- ============================================================================
do $$
declare
  c_lock_timeout constant text := '3s';
  v_applied   boolean;
  v_lines     text[] := '{}';
  v_tests     text[] := '{}';
  v_fail      int := 0;
  v_orphans   int := 0;
  v_report    text;
  r           record;
  v_uid       uuid;
  v_id        uuid;
  v_ws        uuid;
  v_other     uuid;
  v_n         int;
  v_state     text;
  v_msg       text;
begin
  -- ============================================================ 0) příprava
  if not exists (select 1 from pg_class c
                  where c.oid = 'public.tasks'::regclass
                    and pg_has_role(current_user, c.relowner, 'MEMBER')) then
    raise exception 'Test selhal: spusť jako vlastník tabulek (postgres), ne jako %', current_user;
  end if;
  perform set_config('lock_timeout', c_lock_timeout, true);
  v_applied := exists (select 1 from pg_trigger
                        where tgname = 'after_ws_member_delete_projects' and not tgisinternal);

  -- ============================================================ 1) koho úklid odpojí
  for r in
    select w.name as firma,
           coalesce(pr.email, left(pm.user_id::text, 8)) as kdo,
           count(*) as n,
           string_agg(p.name, ', ' order by p.name) as projekty
      from public.project_members pm
      join public.projects p on p.id = pm.project_id
      join public.workspaces w on w.id = p.workspace_id
      left join public.profiles pr on pr.id = pm.user_id
     where not exists (select 1 from public.workspace_members m
                        where m.workspace_id = p.workspace_id and m.user_id = pm.user_id)
     group by w.name, coalesce(pr.email, left(pm.user_id::text, 8))
     order by w.name, 2
  loop
    v_orphans := v_orphans + r.n;
    if cardinality(v_lines) < 30 then
      v_lines := v_lines || format('úklid: %s — %s (projektů %s: %s)',
                                   r.firma, r.kdo, r.n, left(r.projekty, 150));
    end if;
  end loop;
  if v_orphans = 0 then
    v_lines := v_lines || 'úklid: nikoho — žádné členství v projektech firmy, ve které člověk není'::text;
  end if;

  -- ============================================================ 2) 0048 dočasně (není-li)
  if not v_applied then
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
  end if;

  -- ============================================================ 3) zkoušky
  -- Každá zkouška v podtransakci: jako role authenticated s JWT daného
  -- uživatele zkusí úpravu; výsledek se zapíše a podtransakce se odvolá
  -- (errcode KR048), takže data zůstanou beze změny.

  -- 3a) autor úkolu: admin firmy nesmí přepsat created_by svého úkolu
  select t.id, t.created_by, t.workspace_id into v_id, v_uid, v_ws
    from public.tasks t
    join public.workspace_members m
      on m.workspace_id = t.workspace_id and m.user_id = t.created_by and m.role = 'admin'
   where not t.is_private
   order by t.created_at desc
   limit 1;
  select m.user_id into v_other
    from public.workspace_members m
   where m.workspace_id = v_ws and m.user_id <> v_uid
   limit 1;
  if v_id is null or v_other is null then
    v_tests := v_tests || '– autor úkolu: chybí vhodný úkol (admin jako autor + druhý člen)'::text;
  else
    -- kontrola: běžná úprava úkolu projde
    begin
      execute 'set local role authenticated';
      perform set_config('request.jwt.claim.sub', v_uid::text, true);
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
      update public.tasks set title = title where id = v_id;
      get diagnostics v_n = row_count;
      v_state := case when v_n = 1 then 'ok' else 'nic' end;
      raise exception using errcode = 'KR048';
    exception
      when sqlstate 'KR048' then null;
      when others then v_state := 'err'; v_msg := sqlerrm;
    end;
    if v_state = 'ok' then
      v_tests := v_tests || '✓ úkol: běžná úprava autorem-adminem prošla'::text;
    else
      v_fail := v_fail + 1;
      v_tests := v_tests || format('✗ úkol: běžná úprava neprošla (%s %s)', v_state, coalesce(v_msg, ''));
    end if;
    -- vlastní zkouška: změna autora musí selhat
    v_msg := null;
    begin
      execute 'set local role authenticated';
      perform set_config('request.jwt.claim.sub', v_uid::text, true);
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
      update public.tasks set created_by = v_other where id = v_id;
      v_state := 'prošlo';
      raise exception using errcode = 'KR048';
    exception
      when sqlstate 'KR048' then null;
      when others then v_state := 'blok'; v_msg := sqlerrm;
    end;
    if v_state = 'blok' and v_msg like 'Autora úkolu%' then
      v_tests := v_tests || '✓ úkol: změna autora zablokována'::text;
    else
      v_fail := v_fail + 1;
      v_tests := v_tests || format('✗ úkol: změna autora %s (%s)', v_state, coalesce(v_msg, 'bez chyby'));
    end if;
  end if;

  -- 3b) záznam času: autor nesmí přesunout svůj záznam do jiné firmy
  v_id := null; v_uid := null; v_ws := null; v_other := null;
  select e.id, e.user_id, e.workspace_id into v_id, v_uid, v_ws
    from public.time_entries e
    join public.workspace_members m
      on m.workspace_id = e.workspace_id and m.user_id = e.user_id
   where e.stopped_at is not null
   order by e.started_at desc
   limit 1;
  select w.id into v_other from public.workspaces w where w.id <> v_ws limit 1;
  if v_id is null then
    v_tests := v_tests || '– záznam času: chybí vhodný záznam'::text;
  else
    v_msg := null;
    begin
      execute 'set local role authenticated';
      perform set_config('request.jwt.claim.sub', v_uid::text, true);
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
      update public.time_entries set description = description, project_id = project_id
       where id = v_id;
      get diagnostics v_n = row_count;
      v_state := case when v_n = 1 then 'ok' else 'nic' end;
      raise exception using errcode = 'KR048';
    exception
      when sqlstate 'KR048' then null;
      when others then v_state := 'err'; v_msg := sqlerrm;
    end;
    if v_state = 'ok' then
      v_tests := v_tests || '✓ záznam času: běžná úprava (popis, stejný projekt) prošla'::text;
    else
      v_fail := v_fail + 1;
      v_tests := v_tests || format('✗ záznam času: běžná úprava neprošla (%s %s)', v_state, coalesce(v_msg, ''));
    end if;
    if v_other is null then
      v_tests := v_tests || '– záznam času: jen jedna firma, přesun nejde zkusit'::text;
    else
      v_msg := null;
      begin
        execute 'set local role authenticated';
        perform set_config('request.jwt.claim.sub', v_uid::text, true);
        perform set_config('request.jwt.claims',
          json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
        update public.time_entries set workspace_id = v_other, project_id = null, task_id = null
         where id = v_id;
        get diagnostics v_n = row_count;
        v_state := case when v_n = 1 then 'prošlo' else 'nic nezměnilo' end;
        raise exception using errcode = 'KR048';
      exception
        when sqlstate 'KR048' then null;
        when others then v_state := 'blok'; v_msg := sqlerrm;
      end;
      if v_state = 'blok' and v_msg like 'Záznam času nelze přesunout%' then
        v_tests := v_tests || '✓ záznam času: přesun do jiné firmy zablokován'::text;
      else
        v_fail := v_fail + 1;
        v_tests := v_tests || format('✗ záznam času: přesun do jiné firmy %s (%s)', v_state, coalesce(v_msg, 'bez chyby'));
      end if;
    end if;
    -- projekt z jiné firmy
    v_other := null;
    select p.id into v_other from public.projects p where p.workspace_id <> v_ws limit 1;
    if v_other is not null then
      v_msg := null;
      begin
        execute 'set local role authenticated';
        perform set_config('request.jwt.claim.sub', v_uid::text, true);
        perform set_config('request.jwt.claims',
          json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
        update public.time_entries set project_id = v_other, task_id = null where id = v_id;
        get diagnostics v_n = row_count;
        v_state := case when v_n = 1 then 'prošlo' else 'nic nezměnilo' end;
        raise exception using errcode = 'KR048';
      exception
        when sqlstate 'KR048' then null;
        when others then v_state := 'blok'; v_msg := sqlerrm;
      end;
      if v_state = 'blok' and v_msg like 'Projekt nepatří%' then
        v_tests := v_tests || '✓ záznam času: projekt z jiné firmy zablokován'::text;
      else
        v_fail := v_fail + 1;
        v_tests := v_tests || format('✗ záznam času: projekt z jiné firmy %s (%s)', v_state, coalesce(v_msg, 'bez chyby'));
      end if;
    end if;
  end if;

  -- 3c) komentář: autor nesmí přesunout komentář k jinému úkolu
  v_id := null; v_uid := null; v_other := null;
  select c.id, c.author_id into v_id, v_uid
    from public.task_comments c
    join public.workspace_members m
      on m.workspace_id = c.workspace_id and m.user_id = c.author_id
   order by c.created_at desc
   limit 1;
  select t.id into v_other
    from public.tasks t
   where t.id <> (select c.task_id from public.task_comments c where c.id = v_id)
   limit 1;
  if v_id is null or v_other is null then
    v_tests := v_tests || '– komentář: chybí vhodný komentář'::text;
  else
    v_msg := null;
    begin
      execute 'set local role authenticated';
      perform set_config('request.jwt.claim.sub', v_uid::text, true);
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
      update public.task_comments set body = body where id = v_id;
      get diagnostics v_n = row_count;
      v_state := case when v_n = 1 then 'ok' else 'nic' end;
      raise exception using errcode = 'KR048';
    exception
      when sqlstate 'KR048' then null;
      when others then v_state := 'err'; v_msg := sqlerrm;
    end;
    if v_state = 'ok' then
      v_tests := v_tests || '✓ komentář: úprava textu prošla'::text;
    else
      v_fail := v_fail + 1;
      v_tests := v_tests || format('✗ komentář: úprava textu neprošla (%s %s)', v_state, coalesce(v_msg, ''));
    end if;
    v_msg := null;
    begin
      execute 'set local role authenticated';
      perform set_config('request.jwt.claim.sub', v_uid::text, true);
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
      update public.task_comments set task_id = v_other where id = v_id;
      get diagnostics v_n = row_count;
      v_state := case when v_n = 1 then 'prošlo' else 'nic nezměnilo' end;
      raise exception using errcode = 'KR048';
    exception
      when sqlstate 'KR048' then null;
      when others then v_state := 'blok'; v_msg := sqlerrm;
    end;
    if v_state = 'blok' and v_msg like 'Záznam nelze přesunout%' then
      v_tests := v_tests || '✓ komentář: přesun k jinému úkolu zablokován'::text;
    else
      v_fail := v_fail + 1;
      v_tests := v_tests || format('✗ komentář: přesun k jinému úkolu %s (%s)', v_state, coalesce(v_msg, 'bez chyby'));
    end if;
  end if;

  -- 3d) sloupec nástěnky: admin firmy nesmí přesunout sloupec do jiného projektu
  v_id := null; v_uid := null; v_other := null;
  select c.id, m.user_id into v_id, v_uid
    from public.board_columns c
    join public.workspace_members m
      on m.workspace_id = c.workspace_id and m.role = 'admin'
   order by c.created_at desc
   limit 1;
  select p.id into v_other
    from public.projects p
   where p.id <> (select c.project_id from public.board_columns c where c.id = v_id)
   limit 1;
  if v_id is null or v_other is null then
    v_tests := v_tests || '– sloupec: chybí vhodný sloupec / admin'::text;
  else
    v_msg := null;
    begin
      execute 'set local role authenticated';
      perform set_config('request.jwt.claim.sub', v_uid::text, true);
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
      update public.board_columns set project_id = v_other where id = v_id;
      get diagnostics v_n = row_count;
      v_state := case when v_n = 1 then 'prošlo' else 'nic nezměnilo' end;
      raise exception using errcode = 'KR048';
    exception
      when sqlstate 'KR048' then null;
      when others then v_state := 'blok'; v_msg := sqlerrm;
    end;
    if v_state = 'blok' and v_msg like 'Sloupec nelze přesunout%' then
      v_tests := v_tests || '✓ sloupec: přesun do jiného projektu zablokován'::text;
    else
      v_fail := v_fail + 1;
      v_tests := v_tests || format('✗ sloupec: přesun do jiného projektu %s (%s)', v_state, coalesce(v_msg, 'bez chyby'));
    end if;
  end if;

  -- 3e) odebrání z firmy: člen s projekty přijde o projekty té firmy
  v_uid := null; v_ws := null;
  select m.user_id, m.workspace_id into v_uid, v_ws
    from public.workspace_members m
    join public.profiles pr on pr.id = m.user_id
   where m.role = 'member' and not pr.is_super_admin
     and exists (select 1 from public.project_members pm
                  join public.projects p on p.id = pm.project_id
                 where pm.user_id = m.user_id and p.workspace_id = m.workspace_id)
   order by m.created_at desc
   limit 1;
  if v_uid is null then
    v_tests := v_tests || '– odebrání z firmy: chybí člen s projekty'::text;
  else
    v_msg := null;
    begin
      delete from public.workspace_members where workspace_id = v_ws and user_id = v_uid;
      execute 'set local role authenticated';
      perform set_config('request.jwt.claim.sub', v_uid::text, true);
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
      select count(*) into v_n from public.projects p where p.workspace_id = v_ws;
      v_state := v_n::text;
      raise exception using errcode = 'KR048';
    exception
      when sqlstate 'KR048' then null;
      when others then v_state := 'err'; v_msg := sqlerrm;
    end;
    if v_state = '0' then
      v_tests := v_tests || '✓ odebrání z firmy: odebraný člen už nevidí žádný projekt té firmy'::text;
    else
      v_fail := v_fail + 1;
      v_tests := v_tests || format('✗ odebrání z firmy: odebraný člen dál vidí projektů: %s %s',
                                   v_state, coalesce(v_msg, ''));
    end if;
  end if;

  -- ============================================================ 4) výsledek
  v_report := case when v_fail > 0 then format('CHYBY: %s', v_fail) else 'OK' end
    || ' · ' || case when v_applied then 'stav: 0048 nasazená'
                     else 'stav: 0048 NENÍ nasazená — test ji zkusil dočasně' end;
  if v_applied and v_orphans > 0 then
    v_report := v_report || ' · POZOR: po nasazení zůstalo členství bez firmy';
  end if;
  foreach v_msg in array v_lines loop
    v_report := v_report || chr(10) || v_msg;
  end loop;
  foreach v_msg in array v_tests loop
    v_report := v_report || chr(10) || 'test: ' || v_msg;
  end loop;
  v_report := v_report || chr(10)
    || '(Chyba je záměr: raise exception vrátil vše zpět, v databázi nic nezůstalo.)';
  raise exception '%', v_report;
end
$$;
