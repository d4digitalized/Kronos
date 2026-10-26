-- Denní list přes propojené účty: jeden člověk s účtem na každou firmu
-- (DENULAR, proStavaře, Office) vidí jeden list. Každá položka nese firmu
-- (workspace_id) a fyzicky patří účtu, který je v té firmě členem — list
-- jen skládá položky všech propojených účtů dohromady.
--
-- Skupina = vlastník (owner_id) + účty k němu propojené. Propojení
-- zakládá jen správce přes SQL — tabulka nemá policy pro zápis; kdyby šlo
-- svépomocí, kdokoli by si připojil cizí soukromý list.

create table public.daylist_links (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  check (user_id <> owner_id)
);

alter table public.daylist_links enable row level security;

-- vidím jen své propojení (zápis jen service role / SQL editor)
create policy daylist_links_select on public.daylist_links for select
  using (user_id = (select auth.uid()));

-- jen jedna úroveň: vlastník nesmí být sám propojený a propojený účet
-- nesmí být vlastníkem jiných (jinak by každý účet viděl jinou skupinu)
create or replace function public.daylist_links_no_chain()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.daylist_links where user_id = new.owner_id)
     or exists (select 1 from public.daylist_links where owner_id = new.user_id) then
    raise exception 'Denní list: propojení jen o jedné úrovni (vlastník nesmí být propojený účet).';
  end if;
  return new;
end;
$$;

create trigger daylist_links_no_chain
  before insert or update on public.daylist_links
  for each row execute function public.daylist_links_no_chain();

-- domovský účet skupiny: vlastník, nebo já sám (nepropojený)
create or replace function public.daylist_home()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select owner_id from public.daylist_links where user_id = auth.uid()),
    auth.uid()
  )
$$;

-- všechny účty mé skupiny (vč. mě)
create or replace function public.daylist_accounts()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select public.daylist_home()
  union
  select user_id from public.daylist_links where owner_id = public.daylist_home()
$$;

-- firmy skupiny: kterým účtem do nich patřím; is_home = firma domovského
-- účtu (výchozí firma nové položky)
create or replace function public.daylist_firms()
returns table (workspace_id uuid, name text, account_id uuid, is_home boolean)
language sql
stable
security definer
set search_path = public
as $$
  select distinct on (m.workspace_id)
    m.workspace_id, w.name, m.user_id, m.user_id = public.daylist_home()
  from public.workspace_members m
  join public.workspaces w on w.id = m.workspace_id
  where m.user_id in (select public.daylist_accounts())
  order by m.workspace_id,
    (m.user_id = auth.uid()) desc,
    (m.user_id = public.daylist_home()) desc,
    m.created_at
$$;

-- Účet skupiny, kterému karta v denním listu patří (null = žádnému).
-- Výběr jako Můj den: řeší ji, nebo je autor bez řešitelů — a smí ji vidět
-- (skrytá jen autorovi, člen firmy, u projektové karty člen projektu nebo
-- admin). Přednost má přihlášený účet.
create or replace function public.daylist_card_account(p_task_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.user_id
  from public.tasks t
  join public.workspace_members m on m.workspace_id = t.workspace_id
  where t.id = p_task_id
    and m.user_id in (select public.daylist_accounts())
    and (not t.is_private or t.created_by = m.user_id)
    and (
      exists (
        select 1 from public.task_assignees a
        where a.task_id = t.id and a.user_id = m.user_id
      )
      or (
        t.created_by = m.user_id
        and not exists (select 1 from public.task_assignees a where a.task_id = t.id)
      )
    )
    and (
      t.project_id is null
      or m.role = 'admin'
      or exists (
        select 1 from public.project_members pm
        where pm.project_id = t.project_id and pm.user_id = m.user_id
      )
    )
  order by (m.user_id = auth.uid()) desc
  limit 1
$$;

-- karty naplánované v Mém dni všech účtů skupiny
create or replace function public.daylist_planned_cards(p_from timestamptz, p_to timestamptz)
returns table (
  id uuid,
  title text,
  planned_start timestamptz,
  planned_end timestamptz,
  completed_at timestamptz,
  workspace_id uuid,
  workspace_name text,
  project_name text
)
language sql
stable
security definer
set search_path = public
as $$
  select t.id, t.title, t.planned_start, t.planned_end, t.completed_at,
         t.workspace_id, w.name, p.name
  from public.tasks t
  join public.workspaces w on w.id = t.workspace_id
  left join public.projects p on p.id = t.project_id
  where t.planned_start >= p_from
    and t.planned_start < p_to
    and public.daylist_card_account(t.id) is not null
  order by t.planned_start
$$;

-- Odškrtnutí / vrácení karty z denního listu z kteréhokoli účtu skupiny.
-- Zápis proběhne pod účtem, kterému karta patří (dočasně se přepne
-- auth.uid()), takže historie karty, notifikace i další výskyt opakované
-- karty vidí jako aktéra člena té firmy, ne cizí účet.
create or replace function public.daylist_set_card_done(p_task_id uuid, p_done boolean)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  acc uuid := public.daylist_card_account(p_task_id);
  prev text := current_setting('request.jwt.claim.sub', true);
  result timestamptz;
begin
  if acc is null then
    raise exception 'Denní list: kartu nemůžeš odškrtnout.' using errcode = '42501';
  end if;
  perform set_config('request.jwt.claim.sub', acc::text, true);
  update public.tasks
  set completed_at = case when p_done then now() end,
      on_hold = case when p_done then false else on_hold end
  where id = p_task_id
  returning completed_at into result;
  perform set_config('request.jwt.claim.sub', coalesce(prev, ''), true);
  return result;
end;
$$;

-- ------------------------------------------------------------ firma na položce

alter table public.day_items
  add column workspace_id uuid references public.workspaces (id) on delete cascade;

-- dosavadní položky: nejstarší firma vlastníka; bez firmy nemají kam patřit
update public.day_items d
set workspace_id = (
  select m.workspace_id from public.workspace_members m
  where m.user_id = d.user_id
  order by m.created_at
  limit 1
)
where workspace_id is null;
delete from public.day_items where workspace_id is null;

alter table public.day_items alter column workspace_id set not null;

create index day_items_workspace on public.day_items (workspace_id);

-- vlastník položky = účet skupiny, který je členem její firmy (přednost má
-- přihlášený). Mění se jen se změnou firmy; přímo user_id přepsat nejde.
create or replace function public.day_items_set_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  acc uuid;
begin
  -- service role / SQL editor: user_id zadává správce
  if auth.uid() is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.workspace_id is not distinct from old.workspace_id then
    new.user_id := old.user_id;
    return new;
  end if;
  select m.user_id into acc
  from public.workspace_members m
  where m.workspace_id = new.workspace_id
    and m.user_id in (select public.daylist_accounts())
  order by (m.user_id = auth.uid()) desc, m.created_at
  limit 1;
  if acc is null then
    raise exception 'Denní list: do této firmy nemáš účet.' using errcode = '42501';
  end if;
  new.user_id := acc;
  return new;
end;
$$;

create trigger day_items_set_owner
  before insert or update on public.day_items
  for each row execute function public.day_items_set_owner();

-- list skupiny: vidím a měním položky všech propojených účtů
drop policy day_items_select on public.day_items;
drop policy day_items_insert on public.day_items;
drop policy day_items_update on public.day_items;
drop policy day_items_delete on public.day_items;

create policy day_items_select on public.day_items for select
  using (user_id in (select public.daylist_accounts()));
create policy day_items_insert on public.day_items for insert
  with check (user_id in (select public.daylist_accounts()));
create policy day_items_update on public.day_items for update
  using (user_id in (select public.daylist_accounts()))
  with check (user_id in (select public.daylist_accounts()));
create policy day_items_delete on public.day_items for delete
  using (user_id in (select public.daylist_accounts()));
