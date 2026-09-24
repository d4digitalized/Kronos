-- ============================================================================
-- Kontrola migrace 0050_vedouci_opakovani_prirazeni.sql — na PRODUKCI, PŘED
-- nasazením i PO něm.
--
-- !!! CHYBA NA KONCI JE ZÁMĚR — VRACÍ VŠE ZPĚT !!!
-- Jediný blok „do", končí raise exception s výsledkem → PostgreSQL odvolá
-- celou transakci: dočasné úkoly, členství a grant, které si test vytvoří,
-- i dočasně nasazenou 0050. V DB nic nezůstane.
--
-- Jak: Supabase → SQL Editor jako postgres, vložit CELÝ soubor, Run.
-- Na chvilku (sekundy) zamkne tabulku tasks — pouštět ideálně mimo špičku.
--
-- Výsledek: „OK" / „CHYBY: N" · stav 0050, pod tím zkoušky:
--   ✓ správně, ✗ chyba, – nešlo (chybí vhodná firma: admin + 2 členové + projekt),
--   „před opravou" = jak se to chovalo bez 0050 (jen když ještě není nasazená).
--
-- Úseky >>> 0050:ddl / <<< a >>> 0050:data / <<< jsou DOSLOVA z migrace
-- (generuje je skript; při změně migrace vygenerovat znovu).
-- ============================================================================
do $$
declare
  c_lock_timeout constant text := '3s';
  v_applied boolean;
  v_tests   text[] := '{}';
  v_fail    int := 0;
  v_report  text;
  v_ws      uuid;
  v_p       uuid;
  v_a       uuid;   -- admin firmy
  v_m       uuid;   -- člen (přiřazuje)
  v_x       uuid;   -- člen (je přiřazován); v testu vedoucího je vedoucím
  v_t1      uuid;   -- úkol s vedoucím, který není členem projektu
  v_t2      uuid;   -- opakovaný úkol
  v_t3      uuid;   -- úkol člena M
  v_title   text := '0050 test ' || left(md5(random()::text), 8);
  v_n       int;
  v_state   text;
  v_msg     text;
begin
  -- ============================================================ 0) příprava
  if not pg_has_role(current_user, 'authenticated', 'MEMBER') then
    raise exception 'Test selhal: role % nemůže přepnout na authenticated (spusť jako postgres)', current_user;
  end if;
  perform set_config('lock_timeout', c_lock_timeout, true);
  v_applied := exists (select 1 from pg_trigger
                        where tgname = 'before_task_completed_recur' and not tgisinternal);

  -- firma s adminem (ne super-admin), aspoň 2 běžnými členy a projektem
  select w.id into v_ws
    from public.workspaces w
   where exists (select 1 from public.workspace_members m
                   join public.profiles p on p.id = m.user_id
                  where m.workspace_id = w.id and m.role = 'admin' and not p.is_super_admin)
     and (select count(*) from public.workspace_members m
            join public.profiles p on p.id = m.user_id
           where m.workspace_id = w.id and m.role = 'member' and not p.is_super_admin) >= 2
     and exists (select 1 from public.projects pr where pr.workspace_id = w.id)
   order by w.created_at
   limit 1;

  if v_ws is null then
    v_tests := v_tests || '– žádná firma s adminem, 2 členy a projektem — zkoušky nejdou provést'::text;
  else
    select m.user_id into v_a
      from public.workspace_members m join public.profiles p on p.id = m.user_id
     where m.workspace_id = v_ws and m.role = 'admin' and not p.is_super_admin
     order by m.user_id limit 1;
    select m.user_id into v_m
      from public.workspace_members m join public.profiles p on p.id = m.user_id
     where m.workspace_id = v_ws and m.role = 'member' and not p.is_super_admin
     order by m.user_id limit 1;
    select m.user_id into v_x
      from public.workspace_members m join public.profiles p on p.id = m.user_id
     where m.workspace_id = v_ws and m.role = 'member' and not p.is_super_admin
       and m.user_id <> v_m
     order by m.user_id limit 1;
    select pr.id into v_p from public.projects pr
     where pr.workspace_id = v_ws order by pr.created_at limit 1;

    -- dočasná data jako postgres (bez RLS), „jménem" admina — triggery
    -- (vedoucí, aktivita) vidí admina jako aktéra
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    insert into public.project_members (project_id, user_id)
    values (v_p, v_m), (v_p, v_x) on conflict do nothing;
    delete from public.assign_grants
     where workspace_id = v_ws and user_id = v_m and target_id = v_x;
    insert into public.tasks (workspace_id, project_id, title, created_by)
    values (v_ws, v_p, v_title || ' řešitelé', v_m)
    returning id into v_t3;
    insert into public.tasks (workspace_id, project_id, title, created_by,
                              recurrence, due_date)
    values (v_ws, v_p, v_title || ' opakování', v_a, 'weekly', current_date)
    returning id into v_t2;
    -- vedoucí X, který není členem projektu
    insert into public.tasks (workspace_id, project_id, title, created_by, lead_id)
    values (v_ws, v_p, v_title || ' vedoucí', v_a, v_x)
    returning id into v_t1;

    -- ========================================================== 1) před opravou
    if not v_applied then
      v_state := null; v_msg := null;
      begin
        delete from public.project_members where project_id = v_p and user_id = v_x;
        execute 'set local role authenticated';
        perform set_config('request.jwt.claim.sub', v_x::text, true);
        perform set_config('request.jwt.claims',
          json_build_object('sub', v_x, 'role', 'authenticated')::text, true);
        update public.tasks set title = title where id = v_t1;
        get diagnostics v_n = row_count;
        v_state := case when v_n = 1 then 'prošlo' else 'nic' end;
        raise exception using errcode = 'KR050';
      exception
        when sqlstate 'KR050' then null;
        when others then v_state := 'blok'; v_msg := sqlerrm;
      end;
      v_tests := v_tests || format('před opravou: vedoucí mimo projekt úkol upraví? %s%s',
        v_state, case when v_msg is null then '' else ' (' || left(v_msg, 80) || ')' end);
    end if;
  end if;

  -- ============================================================ 2) 0050 dočasně (není-li)
  if not v_applied then
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
  end if;

  if v_ws is not null then
    -- ========================================================== 3a) přiřazení
    -- člen sobě: projde
    v_state := null; v_msg := null;
    begin
      execute 'set local role authenticated';
      perform set_config('request.jwt.claim.sub', v_m::text, true);
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_m, 'role', 'authenticated')::text, true);
      insert into public.task_assignees (task_id, user_id) values (v_t3, v_m);
      v_state := 'prošlo';
      raise exception using errcode = 'KR050';
    exception
      when sqlstate 'KR050' then null;
      when others then v_state := 'blok'; v_msg := sqlerrm;
    end;
    if v_state = 'prošlo' then
      v_tests := v_tests || '✓ přiřazení: člen sobě smí'::text;
    else
      v_fail := v_fail + 1;
      v_tests := v_tests || format('✗ přiřazení: člen sobě nesmí (%s)', coalesce(v_msg, '?'));
    end if;

    -- člen jinému bez grantu: zablokováno
    v_state := null; v_msg := null;
    begin
      execute 'set local role authenticated';
      perform set_config('request.jwt.claim.sub', v_m::text, true);
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_m, 'role', 'authenticated')::text, true);
      insert into public.task_assignees (task_id, user_id) values (v_t3, v_x);
      v_state := 'prošlo';
      raise exception using errcode = 'KR050';
    exception
      when sqlstate 'KR050' then null;
      when insufficient_privilege then
        v_state := case when sqlerrm like '%row-level security%' then 'blok' else 'chyba' end;
        v_msg := sqlerrm;
      when others then v_state := 'chyba'; v_msg := sqlerrm;
    end;
    if v_state = 'blok' then
      v_tests := v_tests || '✓ přiřazení: člen jinému bez grantu zablokován'::text;
    else
      v_fail := v_fail + 1;
      v_tests := v_tests || format('✗ přiřazení: člen jinému bez grantu %s (%s)', v_state, coalesce(v_msg, 'bez chyby'));
    end if;

    -- člen jinému s grantem: projde
    insert into public.assign_grants (workspace_id, user_id, target_id)
    values (v_ws, v_m, v_x) on conflict do nothing;
    v_state := null; v_msg := null;
    begin
      execute 'set local role authenticated';
      perform set_config('request.jwt.claim.sub', v_m::text, true);
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_m, 'role', 'authenticated')::text, true);
      insert into public.task_assignees (task_id, user_id) values (v_t3, v_x);
      v_state := 'prošlo';
      raise exception using errcode = 'KR050';
    exception
      when sqlstate 'KR050' then null;
      when others then v_state := 'blok'; v_msg := sqlerrm;
    end;
    if v_state = 'prošlo' then
      v_tests := v_tests || '✓ přiřazení: člen jinému s grantem smí'::text;
    else
      v_fail := v_fail + 1;
      v_tests := v_tests || format('✗ přiřazení: člen jinému s grantem nesmí (%s)', coalesce(v_msg, '?'));
    end if;
    delete from public.assign_grants
     where workspace_id = v_ws and user_id = v_m and target_id = v_x;

    -- admin komukoli z projektu: projde
    v_state := null; v_msg := null;
    begin
      execute 'set local role authenticated';
      perform set_config('request.jwt.claim.sub', v_a::text, true);
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
      insert into public.task_assignees (task_id, user_id) values (v_t3, v_x);
      v_state := 'prošlo';
      raise exception using errcode = 'KR050';
    exception
      when sqlstate 'KR050' then null;
      when others then v_state := 'blok'; v_msg := sqlerrm;
    end;
    if v_state = 'prošlo' then
      v_tests := v_tests || '✓ přiřazení: admin komukoli z projektu smí'::text;
    else
      v_fail := v_fail + 1;
      v_tests := v_tests || format('✗ přiřazení: admin nesmí (%s)', coalesce(v_msg, '?'));
    end if;

    -- ========================================================== 3b) vedoucí
    delete from public.project_members where project_id = v_p and user_id = v_x;
    v_state := null; v_msg := null;
    begin
      execute 'set local role authenticated';
      perform set_config('request.jwt.claim.sub', v_x::text, true);
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_x, 'role', 'authenticated')::text, true);
      update public.tasks set title = title where id = v_t1;
      get diagnostics v_n = row_count;
      if v_n = 1 then
        update public.tasks set completed_at = now() where id = v_t1;
        get diagnostics v_n = row_count;
      end if;
      v_state := case when v_n = 1 then 'prošlo' else 'nic nezměnilo' end;
      raise exception using errcode = 'KR050';
    exception
      when sqlstate 'KR050' then null;
      when others then v_state := 'blok'; v_msg := sqlerrm;
    end;
    if v_state = 'prošlo' then
      v_tests := v_tests || '✓ vedoucí mimo projekt úkol upraví i dokončí'::text;
    else
      v_fail := v_fail + 1;
      v_tests := v_tests || format('✗ vedoucí mimo projekt: %s (%s)', v_state, coalesce(v_msg, 'bez chyby'));
    end if;

    -- ========================================================== 3c) opakování
    -- jako postgres: zkouší se trigger, ne práva
    update public.tasks set completed_at = now() where id = v_t2;
    select count(*) into v_n from public.tasks
     where title = v_title || ' opakování' and id <> v_t2;
    if v_n = 1 then
      update public.tasks set completed_at = null where id = v_t2;
      update public.tasks set completed_at = now() where id = v_t2;
      select count(*) into v_n from public.tasks
       where title = v_title || ' opakování' and id <> v_t2;
      if v_n = 1 then
        v_tests := v_tests || '✓ opakování: dokonči → otevři → dokonči = pořád jedna kopie'::text;
      else
        v_fail := v_fail + 1;
        v_tests := v_tests || format('✗ opakování: po znovudokončení kopií %s (má být 1)', v_n);
      end if;
    else
      v_fail := v_fail + 1;
      v_tests := v_tests || format('✗ opakování: po prvním dokončení kopií %s (má být 1)', v_n);
    end if;
  end if;

  -- ============================================================ 4) výsledek
  v_report := case when v_fail > 0 then format('CHYBY: %s', v_fail) else 'OK' end
    || ' · ' || case when v_applied then 'stav: 0050 nasazená'
                     else 'stav: 0050 NENÍ nasazená — test ji zkusil dočasně' end;
  foreach v_msg in array v_tests loop
    v_report := v_report || chr(10) || 'test: ' || v_msg;
  end loop;
  v_report := v_report || chr(10)
    || '(Chyba je záměr: raise exception vrátil vše zpět, v databázi nic nezůstalo.)';
  raise exception '%', v_report;
end
$$;
