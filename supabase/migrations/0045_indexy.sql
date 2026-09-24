-- Chybějící indexy pro časté dotazy aplikace a kaskády při mazání.
-- Jen přidává indexy — data ani práva se nemění. Tabulky jsou malé,
-- běžný create index proběhne okamžitě (zámek na zápis jen po dobu stavby).

-- nástěnka / nový úkol / MCP filtrují úkoly podle projektu — dosud bez indexu
create index if not exists tasks_project_position_idx
  on public.tasks (project_id, position);

-- Inbox a jeho počítadlo v menu (každá stránka): moje úkoly ve firmě
create index if not exists tasks_created_by_idx
  on public.tasks (created_by, workspace_id);

-- smazání úkolu (kaskáda na time_entries) dosud procházelo celou tabulku
create index if not exists time_entries_task_idx
  on public.time_entries (task_id) where task_id is not null;

-- členství podle uživatele (kontext firmy při každém renderu, sdílení firmy
-- v RLS profilů) — primární klíč začíná workspace_id, tohle nepokryje
create index if not exists workspace_members_user_idx
  on public.workspace_members (user_id);

-- zvoneček: počet nepřečtených (každou minutu a při focusu v každé záložce)
-- dosud četl celou historii notifikací uživatele
create index if not exists notifications_user_unread_idx
  on public.notifications (user_id) where read_at is null;

-- kaskáda z tasks — primární klíč (user_id, task_id) ji nepokryje
create index if not exists task_priority_task_idx
  on public.task_priority (task_id);
