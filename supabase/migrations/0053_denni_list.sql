-- Denní list (/den): osobní todolist na den, mimo karty Kronosu. Plní ho
-- uživatel i agenti přes MCP; jedna sada položek na uživatele napříč
-- firmami. Funkci odemyká admin flagem can_daylist — default vypnuto všem
-- (stačí zapnutý v jedné firmě; je to osobní nástroj, ne pravomoc).
--
-- Nedodělané se na další den nepřesouvají zápisem: dnešní list si při
-- čtení přibere starší nehotové položky (viz docs/plans/2026-10-26-denni-list-design.md).

alter table public.workspace_members
  add column can_daylist boolean not null default false;

create table public.day_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid()
    references public.profiles (id) on delete cascade,
  -- den, na který položka patří (Europe/Prague)
  day date not null,
  -- naplánovaný čas → sekce Naplánované; null → Ostatní
  at time,
  title text not null check (char_length(btrim(title)) between 1 and 500),
  note text not null default '' check (char_length(note) <= 2000),
  -- jen bezpečná schémata — odkaz se renderuje jako <a href>
  link_url text check (link_url is null or link_url ~* '^(https?://|mailto:)'),
  link_label text check (link_label is null or char_length(link_label) <= 60),
  source text not null default 'me' check (source in ('me', 'agent')),
  done_at timestamptz,
  -- položka převedená na kartu (karta vznikla v Inboxu firmy)
  task_id uuid references public.tasks (id) on delete set null,
  created_at timestamptz not null default now()
);

create index day_items_user_day on public.day_items (user_id, day);
-- přenos nedodělaných: starší nehotové položky uživatele
create index day_items_user_open on public.day_items (user_id, day)
  where done_at is null;
-- smazání karty (on delete set null)
create index day_items_task on public.day_items (task_id)
  where task_id is not null;

alter table public.day_items enable row level security;

-- soukromé: vidí a mění je jen vlastník
create policy day_items_select on public.day_items for select
  using (user_id = (select auth.uid()));
create policy day_items_insert on public.day_items for insert
  with check (user_id = (select auth.uid()));
create policy day_items_update on public.day_items for update
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy day_items_delete on public.day_items for delete
  using (user_id = (select auth.uid()));
