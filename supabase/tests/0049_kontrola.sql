-- ============================================================================
-- Kontrola migrace 0049_prilohy_jen_pro_viditelne_karty.sql — na PRODUKCI,
-- PŘED nasazením i PO něm.
--
-- !!! CHYBA NA KONCI JE ZÁMĚR — VRACÍ VŠE ZPĚT !!!
-- Jediný blok „do", končí raise exception s výsledkem → PostgreSQL odvolá
-- celou transakci. Když 0049 ještě není nasazená, test si ji jen dočasně
-- nasadí; zkušební nahrání se vrátí. V DB ani v úložišti nic nezůstane
-- (do úložiště se nic nenahrává — zkouší se jen záznam v storage.objects).
--
-- Jak: Supabase → SQL Editor jako postgres, vložit CELÝ soubor, Run.
--
-- Výsledek: „OK" / „CHYBY: N" · stav 0049. Pod tím:
--   přílohy: kolik je v úložišti,
--   přijde o: kdo po změně neuvidí přílohy karet, které nevidí (dřív viděl
--             všechny přílohy své firmy) — „dřív X → teď Y",
--   test: zkoušky jako skutečný uživatel (✓ správně, ✗ chyba, – nešlo).
-- Kdokoli by po změně viděl VÍC než dřív, je chyba (✗ „získal").
--
-- Úsek mezi značkami >>> 0049:ddl / <<< je DOSLOVA z migrace (generuje ho
-- skript; při změně migrace vygenerovat znovu).
-- ============================================================================
do $$
declare
  c_lock_timeout constant text := '3s';
  v_applied  boolean;
  v_total    int;
  v_lines    text[] := '{}';
  v_tests    text[] := '{}';
  v_fail     int := 0;
  v_lose     int := 0;
  v_report   text;
  r          record;
  v_old      int;
  v_new      int;
  v_msg      text;
  v_state    text;
  v_path     text;
  v_task     uuid;
  v_ws       uuid;
  v_owner    uuid;
  v_uid      uuid;
  v_see      boolean;
  v_n        int;
begin
  -- ============================================================ 0) příprava
  if not pg_has_role(current_user, 'authenticated', 'MEMBER') then
    raise exception 'Test selhal: role % nemůže přepnout na authenticated (spusť jako postgres)', current_user;
  end if;
  perform set_config('lock_timeout', c_lock_timeout, true);
  v_applied := exists (select 1 from pg_policies
                        where schemaname = 'storage' and tablename = 'objects'
                          and policyname = 'task_attachments_obj_select'
                          and qual like '%task_attachments%');
  select count(*) into v_total from storage.objects where bucket_id = 'task-attachments';

  -- ============================================================ 1) 0049 dočasně (není-li)
  if not v_applied then
-- >>> 0049:ddl
-- čtecí politika hledá záznam přílohy podle cesty
create index if not exists task_attachments_object_path_idx
  on public.task_attachments (object_path);

drop policy if exists task_attachments_obj_select on storage.objects;
create policy task_attachments_obj_select on storage.objects for select
  to authenticated
  using (
    bucket_id = 'task-attachments'
    and (
      owner = (select auth.uid())
      or (select public.is_super_admin())
      or (storage.foldername(name))[1] = any ((select public.my_admin_ws_ids())::text[])
      or exists (select 1 from public.task_attachments a
                  where a.object_path = storage.objects.name)
    )
  );

-- case: přetypování na uuid až po kontrole tvaru (pořadí v AND není zaručené)
drop policy if exists task_attachments_obj_insert on storage.objects;
create policy task_attachments_obj_insert on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'task-attachments'
    and case
      when (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
       and (storage.foldername(name))[2] ~ '^[0-9a-fA-F-]{36}$'
      then exists (select 1 from public.tasks t
                    where t.id = ((storage.foldername(name))[2])::uuid
                      and t.workspace_id = ((storage.foldername(name))[1])::uuid)
      else false
    end
  );
-- <<< 0049:ddl
  end if;

  -- ============================================================ 2) kdo co uvidí
  -- dřív: člen firmy z první složky cesty (nebo super-admin) viděl vše;
  -- teď: jako role authenticated s JWT uživatele podle nových politik
  for r in
    select p.id, coalesce(p.email, left(p.id::text, 8)) as kdo, p.is_super_admin
      from public.profiles p
     order by 2
  loop
    select count(*) into v_old
      from storage.objects o
     where o.bucket_id = 'task-attachments'
       and (r.is_super_admin
            or exists (select 1 from public.workspace_members m
                        where m.user_id = r.id
                          and m.workspace_id::text = (storage.foldername(o.name))[1]));
    v_new := null;
    v_msg := null;
    begin
      execute 'set local role authenticated';
      perform set_config('request.jwt.claim.sub', r.id::text, true);
      perform set_config('request.jwt.claims',
        json_build_object('sub', r.id, 'role', 'authenticated')::text, true);
      select count(*) into v_new from storage.objects o where o.bucket_id = 'task-attachments';
      raise exception using errcode = 'KR049';
    exception
      when sqlstate 'KR049' then null;
      when others then v_msg := sqlerrm;
    end;
    if v_new is null then
      v_fail := v_fail + 1;
      v_lines := v_lines || format('✗ %s: čtení úložiště selhalo (%s)', r.kdo, coalesce(v_msg, '?'));
    elsif v_new > v_old then
      v_fail := v_fail + 1;
      v_lines := v_lines || format('✗ %s: získal přístup — dřív %s → teď %s příloh', r.kdo, v_old, v_new);
    elsif v_new < v_old then
      v_lose := v_lose + 1;
      if cardinality(v_lines) < 30 then
        v_lines := v_lines || format('přijde o: %s — dřív %s → teď %s příloh (karty, které nevidí)',
                                     r.kdo, v_old, v_new);
      end if;
    end if;
  end loop;
  if v_lose = 0 then
    v_lines := v_lines || 'přijde o: nikdo — každý vidí všechny karty, ke kterým jsou přílohy'::text;
  end if;

  -- ============================================================ 3) zkoušky
  -- vzorová příloha se záznamem a nahrávajícím, který je pořád členem firmy
  select o.name, a.task_id, a.workspace_id, a.uploaded_by
    into v_path, v_task, v_ws, v_owner
    from public.task_attachments a
    join storage.objects o
      on o.bucket_id = 'task-attachments' and o.name = a.object_path
    join public.workspace_members m
      on m.workspace_id = a.workspace_id and m.user_id = a.uploaded_by
   order by a.created_at desc
   limit 1;

  if v_path is null then
    v_tests := v_tests || '– čtení: v úložišti není žádná příloha se záznamem'::text;
  else
    -- 3a) nahrávající svou přílohu vidí
    v_n := null; v_msg := null;
    begin
      execute 'set local role authenticated';
      perform set_config('request.jwt.claim.sub', v_owner::text, true);
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
      select count(*) into v_n from storage.objects
       where bucket_id = 'task-attachments' and name = v_path;
      raise exception using errcode = 'KR049';
    exception
      when sqlstate 'KR049' then null;
      when others then v_msg := sqlerrm;
    end;
    if v_n = 1 then
      v_tests := v_tests || '✓ čtení: nahrávající svou přílohu vidí'::text;
    else
      v_fail := v_fail + 1;
      v_tests := v_tests || format('✗ čtení: nahrávající svou přílohu nevidí (%s)', coalesce(v_msg, v_n::text));
    end if;

    -- 3b) člen téže firmy, který kartu nevidí, přílohu nevidí
    v_uid := null;
    for r in
      select m.user_id
        from public.workspace_members m
        join public.profiles p on p.id = m.user_id
       where m.workspace_id = v_ws and m.role = 'member' and not p.is_super_admin
         and m.user_id <> v_owner
       order by m.user_id
    loop
      v_see := null;
      begin
        execute 'set local role authenticated';
        perform set_config('request.jwt.claim.sub', r.user_id::text, true);
        perform set_config('request.jwt.claims',
          json_build_object('sub', r.user_id, 'role', 'authenticated')::text, true);
        v_see := exists (select 1 from public.tasks t where t.id = v_task);
        if not v_see then
          select count(*) into v_n from storage.objects
           where bucket_id = 'task-attachments' and name = v_path;
        end if;
        raise exception using errcode = 'KR049';
      exception
        when sqlstate 'KR049' then null;
        when others then v_see := null;
      end;
      if v_see = false then
        v_uid := r.user_id;
        exit;
      end if;
    end loop;
    if v_uid is null then
      v_tests := v_tests || '– čtení: ve firmě přílohy není člen, který by kartu neviděl'::text;
    elsif v_n = 0 then
      v_tests := v_tests || '✓ čtení: člen firmy, který kartu nevidí, přílohu nevidí'::text;
    else
      v_fail := v_fail + 1;
      v_tests := v_tests || '✗ čtení: člen firmy, který kartu nevidí, přílohu pořád vidí'::text;
    end if;
  end if;

  -- 3c) nahrání: ke kartě, kterou vidím, projde; k cizí kartě neprojde.
  -- Zkouší se jen řádek v storage.objects (bez souboru) a hned se odvolá.
  v_task := null; v_ws := null; v_uid := null;
  select t.id, t.workspace_id, m.user_id into v_task, v_ws, v_uid
    from public.tasks t
    join public.workspace_members m
      on m.workspace_id = t.workspace_id and m.role = 'admin'
   order by t.created_at desc
   limit 1;
  if v_task is null then
    v_tests := v_tests || '– nahrání: chybí karta s adminem firmy'::text;
  else
    v_state := null; v_msg := null;
    begin
      execute 'set local role authenticated';
      perform set_config('request.jwt.claim.sub', v_uid::text, true);
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
      insert into storage.objects (bucket_id, name, owner)
      values ('task-attachments', format('%s/%s/0049-test.txt', v_ws, v_task), v_uid);
      v_state := 'prošlo';
      raise exception using errcode = 'KR049';
    exception
      when sqlstate 'KR049' then null;
      when insufficient_privilege then
        v_state := case when sqlerrm like '%row-level security%' then 'blok' else 'jiná chyba' end;
        v_msg := sqlerrm;
      when others then v_state := 'jiná chyba'; v_msg := sqlerrm;
    end;
    if v_state = 'prošlo' then
      v_tests := v_tests || '✓ nahrání: admin ke kartě své firmy smí'::text;
    elsif v_state = 'jiná chyba' then
      v_tests := v_tests || format('– nahrání: nešlo ověřit (%s)', left(v_msg, 120));
    else
      v_fail := v_fail + 1;
      v_tests := v_tests || format('✗ nahrání: admin ke kartě své firmy nesmí (%s)', coalesce(v_msg, '?'));
    end if;

    -- do složky karty z JINÉ firmy (admin ji nevidí, pokud tam není členem)
    v_task := null; v_ws := null;
    select t.id, t.workspace_id into v_task, v_ws
      from public.tasks t
     where not exists (select 1 from public.workspace_members m
                        where m.workspace_id = t.workspace_id and m.user_id = v_uid)
     order by t.created_at desc
     limit 1;
    if v_task is null
       or exists (select 1 from public.profiles p where p.id = v_uid and p.is_super_admin) then
      v_tests := v_tests || '– nahrání: chybí karta cizí firmy (nebo je admin super-admin)'::text;
    else
      v_state := null; v_msg := null;
      begin
        execute 'set local role authenticated';
        perform set_config('request.jwt.claim.sub', v_uid::text, true);
        perform set_config('request.jwt.claims',
          json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
        insert into storage.objects (bucket_id, name, owner)
        values ('task-attachments', format('%s/%s/0049-test.txt', v_ws, v_task), v_uid);
        v_state := 'prošlo';
        raise exception using errcode = 'KR049';
      exception
        when sqlstate 'KR049' then null;
        when insufficient_privilege then
          v_state := case when sqlerrm like '%row-level security%' then 'blok' else 'jiná chyba' end;
          v_msg := sqlerrm;
        when others then v_state := 'jiná chyba'; v_msg := sqlerrm;
      end;
      if v_state = 'blok' then
        v_tests := v_tests || '✓ nahrání: ke kartě cizí firmy zablokováno'::text;
      elsif v_state = 'jiná chyba' then
        v_tests := v_tests || format('– nahrání k cizí kartě: nešlo ověřit (%s)', left(v_msg, 120));
      else
        v_fail := v_fail + 1;
        v_tests := v_tests || '✗ nahrání: ke kartě cizí firmy prošlo'::text;
      end if;
    end if;
  end if;

  -- ============================================================ 4) výsledek
  v_report := case when v_fail > 0 then format('CHYBY: %s', v_fail) else 'OK' end
    || ' · ' || case when v_applied then 'stav: 0049 nasazená'
                     else 'stav: 0049 NENÍ nasazená — test ji zkusil dočasně' end
    || chr(10) || format('přílohy: v úložišti %s', v_total);
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
