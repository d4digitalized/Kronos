-- Smazání karty (i podúkolu) nebo projektu už nemaže odpracovaný čas.
--
-- Dřív měly time_entries.task_id i project_id `on delete cascade`: smazání
-- karty smazalo čas VŠECH lidí, kteří na ní pracovali (dialog to říkal jen
-- tomu, kdo maže), a v Přehledech a výkazech pak záznamy „chyběly".
-- Teď záznam zůstane, jen bez vazby. Aby bylo vidět, na čem se dělalo,
-- zkopíruje se před smazáním název karty (u volného timeru bez karty název
-- projektu) na začátek popisu. Běžící timer na mazané kartě běží dál.

-- staré FK na task_id / project_id (název nehádat — kdyby se lišil, zůstala
-- by vedle nového i stará kaskáda a ta by vyhrála)
do $$
declare
  r record;
begin
  for r in
    select distinct con.conname
    from pg_constraint con
    join pg_attribute att
      on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where con.conrelid = 'public.time_entries'::regclass
      and con.contype = 'f'
      and att.attname in ('task_id', 'project_id')
  loop
    execute format('alter table public.time_entries drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.time_entries
  add constraint time_entries_task_id_fkey foreign key (task_id)
    references public.tasks (id) on delete set null,
  add constraint time_entries_project_id_fkey foreign key (project_id)
    references public.projects (id) on delete set null;

-- security definer: kartu smí smazat autor, i když cizí záznamy času na ní
-- přes RLS upravit nesmí — název se do nich propsat musí
create or replace function public.keep_time_on_task_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.time_entries
     set description = case when description = '' then old.title
                            else old.title || ' — ' || description end
   where task_id = old.id;
  return old;
end;
$$;

drop trigger if exists before_task_delete_keep_time on public.tasks;
create trigger before_task_delete_keep_time
  before delete on public.tasks
  for each row execute function public.keep_time_on_task_delete();

-- záznamy s kartou dostanou název karty z triggeru výš (kaskáda projekt →
-- úkoly ho spustí), tady jen volný timer bez karty
create or replace function public.keep_time_on_project_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.time_entries
     set description = case when description = '' then old.name
                            else old.name || ' — ' || description end
   where project_id = old.id and task_id is null;
  return old;
end;
$$;

drop trigger if exists before_project_delete_keep_time on public.projects;
create trigger before_project_delete_keep_time
  before delete on public.projects
  for each row execute function public.keep_time_on_project_delete();
