-- Propojené účty pro denní list: jeden člověk s účtem na každou firmu má
-- jeden společný list. Propojený účet (user_id) vidí a mění položky
-- vlastníka (owner_id), jako by byly jeho; položky se ukládají pod vlastníka.
--
-- Propojení zakládá jen správce přes SQL — tabulka nemá policy pro zápis.
-- Kdyby šlo svépomocí, kdokoli by si připojil cizí soukromý list.

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
-- nesmí být vlastníkem jiných (jinak by každý viděl jiný list)
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

-- čí denní list přihlášený vidí: propojený účet → vlastník, jinak on sám
create or replace function public.daylist_owner()
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

-- nová položka patří vlastníkovi listu
alter table public.day_items
  alter column user_id set default public.daylist_owner();

drop policy day_items_select on public.day_items;
drop policy day_items_insert on public.day_items;
drop policy day_items_update on public.day_items;
drop policy day_items_delete on public.day_items;

create policy day_items_select on public.day_items for select
  using (user_id = (select public.daylist_owner()));
create policy day_items_insert on public.day_items for insert
  with check (user_id = (select public.daylist_owner()));
create policy day_items_update on public.day_items for update
  using (user_id = (select public.daylist_owner()))
  with check (user_id = (select public.daylist_owner()));
create policy day_items_delete on public.day_items for delete
  using (user_id = (select public.daylist_owner()));
