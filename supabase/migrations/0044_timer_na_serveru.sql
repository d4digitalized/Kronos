-- Timer na serveru: start a stop jednou atomickou transakcí a časem DATABÁZE.
--
-- Dřív to dělal prohlížeč ve 3–4 krocích: SELECT běžícího záznamu → UPDATE
-- stopped_at časem Z HODIN POČÍTAČE → INSERT nového (started_at = now() na
-- serveru). Důsledky:
--  * opožděné hodiny v počítači → stopped_at < started_at → check
--    „stopped_at > started_at" UPDATE odmítl a Stop „nešel" napoprvé;
--    při přepnutí timeru pak INSERT narazil na unikátní index běžícího
--    timeru a nový se tiše nespustil,
--  * délky záznamů posunuté o rozdíl hodin, překryvy záznamů,
--  * souběhy mezi kroky (dvojklik, víc záložek).
--
-- Start i stop si nejdřív vezmou zámek na uživatele: souběžný stop (druhá
-- záložka, MCP) tak počká na dokončení startu a zastaví i právě založený
-- záznam, místo aby ho ve starém snímku minul; dva starty se seřadí. Čas
-- se bere až po zámku (clock_timestamp), takže konec předchozího a začátek
-- nového záznamu na sebe přesně navazují.
--
-- Funkce běží jako volající (security invoker) — RLS na time_entries,
-- tasks i projects platí beze změny. Vrací i čas serveru, podle kterého si
-- prohlížeč srovná hodiny pro zobrazení běžícího času.
-- Klient (lib/timer.ts) umí i starou cestu, dokud tahle migrace neběží.

-- záznam + název úkolu a projektu (tvar jako select "*, tasks(title), projects(name)")
create or replace function public.timer_entry_json(e public.time_entries)
returns jsonb language sql stable security invoker set search_path = public as $$
  select to_jsonb(e) || jsonb_build_object(
    'tasks', (select jsonb_build_object('title', t.title)
              from public.tasks t where t.id = e.task_id),
    'projects', (select jsonb_build_object('name', p.name)
                 from public.projects p where p.id = e.project_id)
  )
$$;

-- běžící timer přihlášeného (entry = null, když nic neběží)
create or replace function public.timer_current()
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_row public.time_entries;
begin
  -- bez přihlášení NEvracet „nic neběží" — klient by schoval běžící timer
  if v_uid is null then
    raise exception 'Nepřihlášený uživatel' using errcode = '28000';
  end if;
  select * into v_row from public.time_entries
   where user_id = v_uid and stopped_at is null
   limit 1;
  return jsonb_build_object(
    'server_now', clock_timestamp(),
    'entry', case when v_row.id is null then null
                  else public.timer_entry_json(v_row) end
  );
end;
$$;

-- zastaví běžící timer (p_description = null → popis beze změny)
create or replace function public.timer_stop(p_description text default null)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz;
  v_row public.time_entries;
begin
  if v_uid is null then
    raise exception 'Nepřihlášený uživatel' using errcode = '28000';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('kronos:timer:' || v_uid::text, 0));
  v_now := clock_timestamp();
  update public.time_entries
     set stopped_at = greatest(v_now, started_at + interval '1 second'),
         description = coalesce(p_description, description)
   where user_id = v_uid and stopped_at is null
  returning * into v_row;
  return jsonb_build_object(
    'server_now', clock_timestamp(),
    'stopped', case when v_row.id is null then null
                    else public.timer_entry_json(v_row) end
  );
end;
$$;

-- zastaví případný běžící timer a spustí nový — obojí, nebo nic
create or replace function public.timer_start(
  p_workspace uuid,
  p_project uuid default null,
  p_task uuid default null,
  p_description text default ''
)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz;
  v_prev public.time_entries;
  v_new public.time_entries;
begin
  if v_uid is null then
    raise exception 'Nepřihlášený uživatel' using errcode = '28000';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('kronos:timer:' || v_uid::text, 0));
  v_now := clock_timestamp();
  update public.time_entries
     set stopped_at = greatest(v_now, started_at + interval '1 second')
   where user_id = v_uid and stopped_at is null
  returning * into v_prev;
  -- RLS entries_insert ověří členství i projekt/úkol z téže firmy; při chybě
  -- se vrátí i zastavení předchozího (jedna transakce)
  insert into public.time_entries
    (workspace_id, project_id, task_id, description, user_id, started_at)
  values
    (p_workspace, p_project, p_task, coalesce(p_description, ''), v_uid,
     greatest(v_now, coalesce(v_prev.stopped_at, v_now)))
  returning * into v_new;
  return jsonb_build_object(
    'server_now', clock_timestamp(),
    'entry', public.timer_entry_json(v_new),
    'previous', case when v_prev.id is null then null
                     else public.timer_entry_json(v_prev) end
  );
end;
$$;

-- jen přihlášení (Supabase jinak dává execute na nové funkce i anon)
revoke execute on function public.timer_entry_json(public.time_entries) from public, anon;
revoke execute on function public.timer_current() from public, anon;
revoke execute on function public.timer_stop(text) from public, anon;
revoke execute on function public.timer_start(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.timer_entry_json(public.time_entries) to authenticated;
grant execute on function public.timer_current() to authenticated;
grant execute on function public.timer_stop(text) to authenticated;
grant execute on function public.timer_start(uuid, uuid, uuid, text) to authenticated;
