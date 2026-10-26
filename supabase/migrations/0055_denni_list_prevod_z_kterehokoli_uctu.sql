-- Denní list: převod položky na kartu z kteréhokoli propojeného účtu.
-- Dřív kartu zakládal přihlášený účet přímo (RLS na tasks) — pod účtem
-- Office tedy nešlo založit kartu do proStavaře.cz. Teď karta vznikne pod
-- účtem, kterému položka patří (člen její firmy; dočasně se přepne
-- auth.uid(), stejně jako u daylist_set_card_done z 0054), a položka se
-- v téže transakci odškrtne a odkáže na kartu.

create or replace function public.daylist_promote_item(p_item_id uuid, p_title text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  it public.day_items;
  prev text := current_setting('request.jwt.claim.sub', true);
  new_task uuid;
begin
  select * into it from public.day_items
  where id = p_item_id and user_id in (select public.daylist_accounts());
  if it.id is null then
    raise exception 'Denní list: položka nenalezena.' using errcode = 'P0002';
  end if;
  if it.task_id is not null then
    raise exception 'Denní list: položka už je převedená na kartu.' using errcode = '23505';
  end if;
  if btrim(coalesce(p_title, '')) = '' then
    raise exception 'Denní list: karta potřebuje název.' using errcode = '22023';
  end if;
  -- zakládat smí jen účet, který ve firmě úkoly zakládat smí
  -- („jen měření času" / výkaz v % ne; adminům se flag ignoruje)
  if not exists (
    select 1 from public.workspace_members m
    where m.workspace_id = it.workspace_id
      and m.user_id = it.user_id
      and (m.role = 'admin' or not (m.time_only or m.percent_report))
  ) then
    raise exception 'Denní list: v této firmě úkoly zakládat nemůžeš.' using errcode = '42501';
  end if;

  -- karta do Inboxu firmy položky, autorem je účet té firmy
  perform set_config('request.jwt.claim.sub', it.user_id::text, true);
  insert into public.tasks (workspace_id, project_id, column_id, title, description, position)
  values (
    it.workspace_id, null, null, btrim(p_title),
    concat_ws(E'\n\n', nullif(it.note, ''), it.link_url), 0
  )
  returning id into new_task;
  perform set_config('request.jwt.claim.sub', coalesce(prev, ''), true);

  update public.day_items set done_at = now(), task_id = new_task where id = it.id;
  return new_task;
end;
$$;
