# Denní list — design

*Brainstorming 2026-10-26. Mockup: https://claude.ai/artifact/7Byo3EAJTcDTqbLvQFURcq*

## Co to je

Jednoduchý todolist bez distrakcí na jeden den — „nákupní seznam" vedle
Kronosu. Ráno ho naplní agenti (přes MCP), přes den si do něj člověk
připisuje sám. Položky žijí **mimo karty Kronosu**; z kterékoli jde jedním
klikem udělat kartu.

- Samostatná obrazovka **vizuálně oddělená** od aplikace: bez menu, timeru
  a nástěnek. Jen den, pole na přidání a seznam.
- Adresa: `/den` = vždy dnešek (záložka / ikona na ploše), `/den/26-10-26`
  = konkrétní den (YY-MM-DD). Šipkami se chodí po dnech.
- Jeden list **na uživatele napříč všemi firmami** (jako sekce Master);
  MCP se přihlašuje osobním tokenem, agent tedy firmu neřeší.
- Funkci odemyká admin flagem `can_daylist` u člena (jako Poznámky).
  Stačí zapnutý v jedné firmě. Ráno nic neupozorňuje — stránka je prostě
  připravená.

## Obrazovka

- Hlavička: den v týdnu velkým písmem, datum („Dnes · 26. října"), vpravo
  „zbývá N".
- Pole „Přidat úkol". Čas na začátku (`14:30 zavolat Pepovi`) položku
  naplánuje; u pole se ukáže „v 14:30".
- **Naplánované** — položky s časem a karty z Mého dne (viz níž), řazené
  podle času. **Ostatní** — kdykoli během dne. Nadpisy sekcí jen když
  existují naplánované.
- Položka: kolečko, (čas), text, pod ním šedý řádek s poznámkou a odkazem.
  Od agenta = drobná hvězdička. Přenesená = „od pátku" (mosazně).
- `⋯` u položky: **Udělat kartu v Kronosu**, **Na zítra** (jen na dnešku),
  **Smazat**.
- **Hotovo · N** — sbalené dole, odškrtnuté jdou vrátit.
- Minulé dny jen ke čtení: co se ten den udělalo a co „přešlo dál".
  Budoucí dny jdou plnit dopředu.

## Datový model (migrace 0053)

```
workspace_members.can_daylist  boolean default false

day_items
  id, user_id (default auth.uid())
  day        date          -- den, na který položka patří
  at         time null     -- čas → Naplánované; null → Ostatní
  title, note, link_url (http/https/mailto), link_label
  source     'me' | 'agent'
  done_at    timestamptz null
  task_id    uuid null → tasks (on delete set null)  -- převedeno na kartu
  created_at
```

RLS: vše jen vlastník (`user_id = (select auth.uid())`).

### Přenos nedodělaných = při čtení, ne cronem

Nic se nepřesouvá. Dnešní list = položky s `day = dnes` **plus** starší
nehotové (a starší dokončené dnes). Přenesené ztrácí čas — padnou do
Ostatních se štítkem „od pátku". Minulý den ukazuje jen položky s
`day = ten den`; nehotové v něm mají „přešlo dál". Žádný cron, žádné
souběhy s ranním agentem, historie zůstává pravdivá. „Na zítra" = `day + 1`.

### Karty z Mého dne

Karty s `planned_start` v daném dni (moje = řeším je, nebo jsem autor bez
řešitelů — stejný dotaz jako Můj den) se do Naplánovaných přimíchají
živě. Mají značku firmy/projektu a odkaz na kartu; odškrtnutí kartu
**dokončí** (`completed_at`), vrácení ji znovu otevře. Nemají `⋯`
(plánuje se v Mém dni).

### Převod na kartu

Okno: název (předvyplněný, jde upravit), popis = poznámka + odkaz,
výběr firmy (pamatuje si poslední; skryté, když je jen jedna). Karta
vznikne **v Inboxu vybrané firmy** (bez projektu) a roztřídí se tam.
Položka dostane `done_at` + `task_id` a mezi hotovými ukazuje „Karta v
Inboxu FIRMA · otevřít v Kronosu".

## Firma na položce a propojené účty (migrace 0054)

Jeden člověk s účtem na každou firmu (DENULAR, proStavaře, Office) vidí
**jeden list složený z položek všech tří účtů**.

- **Vlaječka firmy** (`day_items.workspace_id`) u každé položky. Fyzicky
  položka patří účtu, který je členem té firmy — doplní ho trigger podle
  firmy (přímo `user_id` přepsat nejde, mění se jen se změnou firmy).
- **Skupina** = `daylist_links (user_id → owner_id)` + vlastník.
  `daylist_accounts()` = účty skupiny; RLS na `day_items` pouští položky
  všech. Jen jedna úroveň (trigger). Propojení zakládá jen správce přes
  SQL — tabulka nemá policy pro zápis, jinak by si kdokoli připojil cizí
  soukromý list.
- **Výchozí firma** nové položky = firma vlastníka skupiny (u Jana Office);
  po přidání se výběr vrací na ni. Vlaječky a výběr jen když je firem víc.
- **Karty z Mého dne všech účtů** (`daylist_planned_cards`) — výběr jako
  Můj den a jen karty, které by daný účet viděl i sám. **Odškrtnout jdou
  z kteréhokoli účtu** (`daylist_set_card_done`): zapíše se pod účtem, kterému
  karta patří (dočasně přepnuté `auth.uid()`), takže historie, notifikace i
  opakování vidí jako aktéra člena té firmy. Otevřít kartu jde jen účtem,
  který je ve firmě.
- **Převod na kartu** jde do firmy z vlaječky; založit ji smí jen účet
  z té firmy — jinak hláška „založíš, když tu budeš přihlášený jejím účtem".

## MCP pro agenty

| Nástroj | Co dělá |
|---|---|
| `list_day` | firmy skupiny, položky dne (dnešek vč. přenesených) + naplánované karty všech účtů |
| `add_day_items` | přidá položky (`title`, `firm?`, `time?`, `note?`, `link_url?`, `link_label?`), `source = agent` |
| `update_day_item` | změní text/firmu/čas/poznámku/odkaz, přesune na jiný den, odškrtne |
| `remove_day_item` | smaže položku |
| `complete_day_card` | odškrtne kartu z Mého dne kteréhokoli propojeného účtu |

Datum se zadává `YYYY-MM-DD` (výchozí dnešek v Europe/Prague). Bez flagu
`can_daylist` nástroje odmítnou.

## Mimo rozsah (YAGNI)

Ruční řazení přetahováním, úprava textu přímo v listu, opakované položky,
tmavý režim, ranní notifikace, sdílení listu s dalšími lidmi.
