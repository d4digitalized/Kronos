# Kronos — návod pro agenty (MCP)

Kronos je interní úkolovník s měřením času pro firmy Jana Dürrera
(DENULAR, proStavaře.cz, Office). Agent k němu přistupuje přes MCP server
a jedná **pod jménem konkrétního uživatele** — vidí a smí jen to, co ten
uživatel v aplikaci.

## Stack (pro orientaci, ne pro zásahy)

- **Next.js** (App Router, TypeScript, Tailwind) na **Vercelu**, produkce
  `https://kronos.digitalized.cz`, nasazuje se z větve `main`.
- **Supabase**: Postgres s RLS (izolace firem a práv na úrovni databáze),
  Auth (e-mail + heslo, pozvánky), migrace v `supabase/migrations/`.
- **E-maily** přes Resend (notifikace, denní přehled, odpověď na e-mail =
  komentář ke kartě).
- **MCP server**: `POST https://kronos.digitalized.cz/api/mcp`,
  Bearer token `tgl_…` vytvořený v Nastavení → Napojení do Clauda.
  Token = identita uživatele; veškerá oprávnění řeší RLS, MCP nic nepřidává.

## Pojmy

| Pojem | Co to je |
|---|---|
| **Workspace** (firma) | Oddělený prostor: členové, projekty, výkazy. Uživatel může být ve více. |
| **Role** | `member` / `admin` per workspace; `super-admin` globálně (vidí vše, spravuje firmy). |
| **Právo delegovat** (`can_delegate`) | Člen smí nastavovat „Čekám na" a duchy řešitele. Admin má vždy. |
| **Projekt** = nástěnka | Sloupce (Backlog + vlastní) a karty. Člen vidí jen projekty, kde je členem; admin všechny. |
| **Úkol** (karta) | Název, popis, řešitelé, vedoucí, termín (`due_date`), priorita P1–P4, opakování, plán (den + od–do), štítky, podúkoly, checklisty, přílohy, komentáře. |
| **Automatické sloupce** | **Waiting on** (úkol má „Čekám na"), **Hold** (uspaný), **Done** (dokončený). Nejsou to „skutečné" sloupce — řídí je stav úkolu. |
| **Čekám na** (follow-up) | Na koho úkol čeká (člen nebo externí kontakt), od kdy, do kdy slíbil dodat. Úkol se přesune do Waiting on a zadavateli se ukazuje na stránce „Čekám na". |
| **Kontakt / duch** | Externí člověk bez účtu. Lze na něj čekat nebo ho dát jako řešitele; nic nevidí, neodstává notifikace, odškrtává za něj zadavatel. |
| **Výkaz času** | Záznam od–do na projekt (a volitelně úkol) s popisem. Timer = otevřený záznam; jeden běžící na uživatele. |
| **Inbox** | Úkoly bez projektu / k roztřídění. |
| **Denní list** (`/den`) | Osobní todolist na den **mimo karty** — „nákupní seznam" napříč firmami. Položky s časem = Naplánované, bez času = Ostatní. Nedodělané se samy přenáší na další den. Karty naplánované v Mém dni se v něm ukazují také. Z položky si uživatel jedním klikem udělá kartu v Inboxu. Odemyká admin (`can_daylist`). |

## Jak to Jan používá

- Ráno: **Můj den** (plán dne, přetažení úkolů na hodiny → propíše se do
  Google kalendáře „Kronos"), **Moje úkoly**, **Čekám na**.
- Práce: timer z karty nebo volný timer z lišty; komentáře s @zmínkami
  (e-mail se zmínkou nese celé vlákno).
- Delegování: úkol přiřadí členovi, nebo nastaví „Čekám na" externího
  člověka se slíbeným termínem a hlídá to na stránce Čekám na.
- Přehledy: hodiny po lidech a projektech za období (admin / HR).

## Nástroje MCP

### Identita a struktura
- `whoami` — kdo jsem (user_id pro „přiřaď mně").
- `list_workspaces`, `list_projects(workspace_id?)`, `create_project(workspace_id, name)` (admin).
- `list_workspace_members(workspace_id)`, `list_project_members(project_id)`.
- `search_people(workspace_id, query?)` — členové i kontakty podle části jména / e-mailu / tagu.
- `list_contacts(workspace_id)`, `create_contact(workspace_id, name, email?, note?)`.
- `invite_member(workspace_id, email, role?)` — existující účet přidá hned, nový dostane pozvánku (admin).

### Úkoly
- `list_tasks(project_id, include_done?)` — úkoly nástěnky se stavem (open/hold/waiting/done), sloupcem, řešiteli **a seznam sloupců** (pro `move_task`).
- `list_my_tasks` — moje nedokončené.
- `get_task(task_id)` — detail včetně popisu a „Čekám na".
- `create_task(project_id, title, description?, due_date?, assignee_ids?)`.
- `update_task_description(task_id, description)` — **přepíše** popis; pro doplnění nejdřív `get_task`.
- `set_due_date(task_id, due_date)` — YYYY-MM-DD, prázdné = smazat.
- `assign_task(task_id, user_id)` — jen člen projektu nebo admin firmy.
- `assign_contact(task_id, contact_id | contact_name, remove?)` — duch řešitel.
- `set_waiting(task_id, user_id | contact_id | contact_name, waiting_since?, waiting_until?)`, `clear_waiting(task_id)`.
- `complete_task(task_id, completed?)` — hotovo / znovu otevřít (opakovaný úkol založí další výskyt sám).
- `move_task(task_id, column)` — název sloupce, `column_id`, nebo `"hold"`.
- `plan_task(task_id, date, from, to)`, `unplan_task(task_id)` — plánované okno (kalendář), **ne** termín.
- `list_comments(task_id)`, `add_comment(task_id, body)` — `@tag` v textu zmíní kolegu.

### Čas
- `current_timer`, `start_timer(task_id | project_id | workspace_id, description?)`, `stop_timer(description?)`.
- `add_time_entry(date, from, to, task_id | project_id | workspace_id, description?)`.
- `list_time_entries(from, to, workspace_id?, user_id?, project_id?, summary_only?)` — součty po lidech, projektech a jejich kombinaci + záznamy. Vidíš své; admin všechny; HR s grantem.

### Denní list
- `list_day(date?)` — položky dne (u dneška i přenesené, `carried_from`) a karty naplánované v Mém dni (`planned_tasks`, jen ke čtení — dokončují se `complete_task`).
- `add_day_items(date?, items[])` — každá položka `title`, volitelně `time` (HH:MM → Naplánované), `note` (kontext / proč), `link_url` (https:// nebo mailto:), `link_label` (mail, kalendář, Kronos…).
- `update_day_item(item_id, title?, time?, note?, link_url?, link_label?, date?, done?)` — prázdný řetězec hodnotu smaže; `date` položku přesune.
- `remove_day_item(item_id)`.

## Pravidla pro agenta

1. **Nejdřív identita a kontext**: `whoami`, `list_workspaces`, `list_projects`. Neodhaduj ID — vždy je dohledej.
2. **Lidi hledej přes `search_people`.** Řešitelem může být jen člen Kronosu (člen projektu nebo admin). Externí člověk = kontakt → `set_waiting` nebo `assign_contact`. Nový účet zakládej jen na výslovnou žádost (`invite_member` posílá e-mail).
3. **Termín vs. plán**: `set_due_date` = do kdy má být hotovo. `plan_task` = kdy se na tom bude dělat (jde do kalendáře). „Do kdy slíbil dodat" u čekání = `waiting_until`.
4. **Sloupce**: než voláš `move_task`, vezmi názvy z `list_tasks`. Hotovo řeš přes `complete_task`, ne přesunem do Done.
5. **Datum a čas** zadávej jako `YYYY-MM-DD` a `HH:MM` v čase Europe/Prague; výstupy jsou také v pražském čase.
6. **Popis nepřepisuj naslepo**: `get_task` → doplň → `update_task_description`.
7. **Čas**: před `start_timer` se podívej na `current_timer` (start zastaví předchozí). Ruční zápis jen na výslovnou žádost.
8. **Chyby oprávnění** (nenalezen / nemáš přístup) neobcházej — znamená to, že uživatel to nesmí nebo nevidí. Ohlas to.
9. **Odpovědi drž stručné** a pojmenované: název úkolu, projekt, kdo, do kdy. ID uváděj jen když je uživatel potřebuje.
10. **Denní list ≠ karty**: do listu piš drobnosti na den (zavolat, odpovědět, vyzvednout). Práci, která potřebuje řešitele, projekt nebo termín, zakládej jako kartu. Před `add_day_items` vždy `list_day` — nepřidávej, co už tam je (ani přenesené ze včerejška).

## Typické postupy

- **„Zadej Natálii úkol X v HR do pátku"** → `list_projects` (8020_HR) → `search_people("Natálie")` → `create_task(project_id, title, due_date, assignee_ids=[user_id])`.
- **„Čekám na Hanáka s klíčem do 20. 9."** → najdi úkol (`list_tasks` / `list_my_tasks`) → `set_waiting(task_id, contact_name="Hanák", waiting_until="2026-09-20")`.
- **„Co dnes dělat"** → `list_my_tasks` (termíny), `current_timer`; případně `plan_task`.
- **„Kolik kdo tento týden odpracoval"** → `list_time_entries(from, to, summary_only=true)`.
- **„Označ X jako hotové a napiš komentář"** → `complete_task` → `add_comment`.
- **Ranní příprava dne** → `list_day` (co už tam je, co přešlo ze včerejška, co je naplánované v Mém dni) → z mailů, kalendáře a termínů vyber, co je dnes potřeba → `add_day_items` (s časem jen to, co opravdu na čas je; do `note` proč, do `link_url` zdroj).

## Poznámky k připojení

- Konektor v Claudu si načte seznam nástrojů při připojení — po nasazení
  nových nástrojů je potřeba konektor znovu načíst.
- Token lze zrušit v Nastavení; po zrušení všechny volání selžou.
