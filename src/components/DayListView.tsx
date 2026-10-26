"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";
import { pingNotifyEmails } from "@/lib/notify";
import LoadError from "@/components/LoadError";
import { ICONS, NavIcon } from "@/components/nav-shared";
import {
  addDays,
  carriedLabel,
  dayHeading,
  dayHref,
  dayShort,
  defaultFirmId,
  hhmm,
  linkLabel,
  loadPlannedCards,
  parseTimePrefix,
  promoteItem,
  queryDayItems,
  setCardDone,
} from "@/lib/dayList";
import type { DayFirm, DayItem, PlannedCard } from "@/lib/types";

type Firm = { name: string };

/** Půlnoc dne v místním čase jako ISO (hranice pro done_at / planned_start). */
function dayStartISO(day: string): string {
  return new Date(`${day}T00:00`).toISOString();
}

function localHHMM(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Řádek seznamu: vlastní položka, nebo karta naplánovaná v Mém dni. */
type Row =
  | { kind: "item"; key: string; time: string | null; item: DayItem; carried: string | null }
  | { kind: "card"; key: string; time: string; card: PlannedCard };

const byTime = (a: Row, b: Row) => (a.time ?? "").localeCompare(b.time ?? "");

/** Denní list: co mám dnes udělat — mimo karty, bez menu a timeru. Ráno ho
    plní agenti (MCP), přes den si sem píšu sám; z položky jde udělat karta.
    Skládá položky všech propojených účtů (účet na firmu) — každá nese
    vlaječku firmy. Nedodělané z minulých dnů se přiberou při načtení
    dneška (nic se nepřesouvá), karty z Mého dne se přimíchají mezi
    Naplánované a odškrtnout jdou z kteréhokoli účtu. */
export default function DayListView({
  day,
  today,
  firms,
  mineIds,
}: {
  day: string;
  today: string;
  /** firmy všech propojených účtů, domovská první */
  firms: DayFirm[];
  /** firmy přihlášeného účtu — karty v nich jde otevřít */
  mineIds: string[];
}) {
  const supabase = createClient();
  const [items, setItems] = useState<DayItem[]>([]);
  const [cards, setCards] = useState<PlannedCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // pořadí načítání: starší odpověď nesmí přepsat novější
  const loadSeq = useRef(0);
  const homeFirm = defaultFirmId(firms) ?? "";
  const [draft, setDraft] = useState("");
  const [addFirm, setAddFirm] = useState(homeFirm);
  const [adding, setAdding] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [promoting, setPromoting] = useState<DayItem | null>(null);

  const isToday = day === today;
  const isPast = day < today;
  const heading = dayHeading(day, today);
  // vlaječky jen když je z čeho vybírat
  const showFirms = firms.length > 1;
  const firmById = new Map<string, Firm>(
    firms.map((f) => [f.workspace_id, { name: f.name }])
  );
  const firmOf = (id: string): Firm => firmById.get(id) ?? { name: "?" };

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const start = dayStartISO(day);
    const end = dayStartISO(addDays(day, 1));
    const [itemsRes, cardsRes] = await Promise.all([
      queryDayItems(supabase, day, today, start),
      loadPlannedCards(supabase, start, end),
    ]);
    if (seq !== loadSeq.current) return;
    setLoading(false);
    // chyba ≠ prázdný den: necháme, co je vidět
    if (itemsRes.error || cardsRes.error) {
      setLoadError(true);
      return;
    }
    setLoadError(false);
    setItems((itemsRes.data ?? []) as DayItem[]);
    setCards(cardsRes.cards);
  }, [supabase, day, today]);

  useEffect(() => {
    load();
    // agenti můžou psát i během dne — po návratu do záložky dotáhnout
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  const closePromote = useCallback(() => setPromoting(null), []);

  function patchItem(id: string, patch: Partial<DayItem>) {
    setItems((list) => list.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }

  async function toggleItem(item: DayItem) {
    setMenuFor(null);
    const done_at = item.done_at ? null : new Date().toISOString();
    patchItem(item.id, { done_at });
    const { error } = await supabase.from("day_items").update({ done_at }).eq("id", item.id);
    if (error) {
      patchItem(item.id, { done_at: item.done_at });
      toast("Uložení se nezdařilo.", "error");
    }
  }

  async function toggleCard(card: PlannedCard) {
    const done = !card.completed_at;
    const setCompleted = (value: string | null) =>
      setCards((list) =>
        list.map((c) => (c.id === card.id ? { ...c, completed_at: value } : c))
      );
    setCompleted(done ? new Date().toISOString() : null);
    const { completedAt, error } = await setCardDone(supabase, card.id, done);
    if (error) {
      setCompleted(card.completed_at);
      toast("Kartu se nepodařilo uložit.", "error");
      return;
    }
    setCompleted(completedAt);
    if (done) pingNotifyEmails(); // opakovaná karta může přiřadit další výskyt
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || adding || !addFirm) return;
    const timed = parseTimePrefix(text);
    setAdding(true);
    const { data, error } = await supabase
      .from("day_items")
      .insert({
        day,
        workspace_id: addFirm,
        at: timed?.time ?? null,
        title: timed?.title ?? text,
        source: "me",
      })
      .select("*")
      .single();
    setAdding(false);
    if (error || !data) {
      toast("Položku se nepodařilo přidat.", "error");
      return;
    }
    setItems((list) => [...list, data as DayItem]);
    setDraft("");
    setAddFirm(homeFirm); // výchozí je vždy domovská firma
  }

  /** Jiná firma položky — vlastníka (účet té firmy) přepíše DB sama. */
  async function changeFirm(item: DayItem, workspaceId: string) {
    if (workspaceId === item.workspace_id) return;
    patchItem(item.id, { workspace_id: workspaceId });
    const { error } = await supabase
      .from("day_items")
      .update({ workspace_id: workspaceId })
      .eq("id", item.id);
    if (error) {
      patchItem(item.id, { workspace_id: item.workspace_id });
      toast("Firmu se nepodařilo změnit.", "error");
    }
  }

  async function moveToTomorrow(item: DayItem) {
    setMenuFor(null);
    setItems((list) => list.filter((i) => i.id !== item.id));
    const { error } = await supabase
      .from("day_items")
      .update({ day: addDays(today, 1) })
      .eq("id", item.id);
    if (error) {
      setItems((list) => [...list, item]);
      toast("Přesun se nezdařil.", "error");
      return;
    }
    toast(`Na zítra: ${item.title}`);
  }

  async function remove(item: DayItem) {
    setMenuFor(null);
    setItems((list) => list.filter((i) => i.id !== item.id));
    const { error } = await supabase.from("day_items").delete().eq("id", item.id);
    if (error) {
      setItems((list) => [...list, item]);
      toast("Smazání se nezdařilo.", "error");
    }
  }

  /** Karta v Inboxu firmy položky — z kteréhokoli účtu (vznikne pod účtem
      té firmy); položka se odškrtne a odkáže na ni. */
  async function promote(item: DayItem, title: string): Promise<boolean> {
    const { taskId, error } = await promoteItem(supabase, item.id, title);
    if (error || !taskId) {
      // hlášky z DB začínají „Denní list: " — ty jsou srozumitelné
      const known = error?.match(/Denní list: (.+)$/)?.[1];
      toast(known ?? "Kartu se nepodařilo založit.", "error");
      return false;
    }
    patchItem(item.id, { done_at: new Date().toISOString(), task_id: taskId });
    setShowDone(true);
    toast(`Karta je v Inboxu ${firmOf(item.workspace_id).name}.`);
    return true;
  }

  // ---------------------------------------------------------------- řádky

  const endISO = dayStartISO(addDays(day, 1));
  const openRows: Row[] = [];
  const doneRows: Row[] = [];
  for (const item of items) {
    // starší položky načte jen dnešek = přenesené nedodělané; čas ztrácí
    const carried = item.day < day ? carriedLabel(item.day, today) : null;
    const row: Row = {
      kind: "item",
      key: item.id,
      time: carried ? null : hhmm(item.at),
      item,
      carried,
    };
    (item.done_at ? doneRows : openRows).push(row);
  }
  for (const card of cards) {
    const row: Row = { kind: "card", key: card.id, time: localHHMM(card.planned_start), card };
    (card.completed_at ? doneRows : openRows).push(row);
  }
  const planned = openRows.filter((r) => r.time).sort(byTime);
  const others = openRows.filter((r) => !r.time);
  const sections = [
    { key: "planned", label: "Naplánované", rows: planned },
    { key: "other", label: "Ostatní", rows: others },
  ].filter((s) => s.rows.length > 0);
  const doneOf = (r: Row) => (r.kind === "item" ? r.item.done_at : r.card.completed_at) ?? "";
  doneRows.sort((a, b) => doneOf(a).localeCompare(doneOf(b)));

  // minulý den: vše dohromady, hotovo = stihlo se do konce toho dne
  const pastRows = [...planned, ...others, ...doneRows].sort(
    (a, b) => (a.time ? 0 : 1) - (b.time ? 0 : 1) || byTime(a, b)
  );
  const pastDone = (r: Row) => {
    const at = doneOf(r);
    return !!at && at < endISO;
  };

  let countLabel = "";
  if (isPast) {
    if (pastRows.length)
      countLabel = `hotovo ${pastRows.filter(pastDone).length} z ${pastRows.length}`;
  } else if (isToday) {
    if (openRows.length) countLabel = `zbývá ${openRows.length}`;
    else if (doneRows.length) countLabel = "vše hotovo";
  } else if (openRows.length) {
    countLabel = `naplánováno ${openRows.length}`;
  }

  const emptyText = isPast
    ? "Ten den tu nic nebylo."
    : isToday
      ? doneRows.length
        ? "Na dnešek nic nezbývá."
        : "Zatím prázdné. Agenti sem píšou ráno, ty kdykoli."
      : "Zatím prázdné. Agenti ho naplní ráno, ty si sem můžeš psát už teď.";

  const draftTimed = parseTimePrefix(draft);
  const tagOf = (workspaceId: string) => (showFirms ? firmOf(workspaceId) : null);

  return (
    <main className="mx-auto flex w-full max-w-[640px] flex-col gap-7 px-5 pb-20 pt-4">
      <nav aria-label="Přepínání dnů" className="-mx-2.5 flex items-center gap-1">
        <Link
          href={dayHref(addDays(day, -1), today)}
          aria-label="Předchozí den"
          className="inline-flex h-11 items-center gap-1 rounded-lg px-2.5 text-sm text-day-muted hover:text-day-ink"
        >
          <Icon d="M15 18l-6-6 6-6" />
          {dayShort(addDays(day, -1))}
        </Link>
        <span className="flex-1" />
        {!isToday && (
          <Link
            href="/den"
            className="inline-flex h-11 items-center rounded-lg px-3 text-sm font-semibold"
          >
            Dnes
          </Link>
        )}
        <span className="flex-1" />
        <Link
          href={dayHref(addDays(day, 1), today)}
          aria-label="Další den"
          className="inline-flex h-11 items-center gap-1 rounded-lg px-2.5 text-sm text-day-muted hover:text-day-ink"
        >
          {dayShort(addDays(day, 1))}
          <Icon d="M9 18l6-6-6-6" />
        </Link>
      </nav>

      <header className="flex items-end gap-4">
        <div className="min-w-0 flex-1">
          <p className="mb-1.5 text-sm text-day-muted">{heading.date}</p>
          <h1 className="font-day-display text-[clamp(44px,10vw,68px)] font-[650] leading-[0.95] tracking-[-0.025em]">
            {heading.weekday}
          </h1>
        </div>
        <p className="mb-1 whitespace-nowrap text-sm text-day-muted">{countLabel}</p>
      </header>

      {!isPast && (
        <form
          onSubmit={add}
          className="-ml-[11px] flex items-center gap-0.5 border-b-[1.5px] border-day-line focus-within:border-day-ink"
        >
          <span
            aria-hidden
            className="flex h-12 w-11 shrink-0 items-center justify-center text-day-muted"
          >
            <Icon d="M12 5v14M5 12h14" size={20} />
          </span>
          {showFirms && (
            <span className="shrink-0 pr-2">
              <FirmPicker
                firms={firms}
                value={addFirm}
                onChange={setAddFirm}
                triggerClass="inline-flex h-8 items-center gap-1 rounded-md px-1 text-[13px] font-medium text-day-muted hover:text-day-ink"
              />
            </span>
          )}
          <label htmlFor="day-new" className="sr-only">
            Nový úkol
          </label>
          <input
            id="day-new"
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={500}
            autoComplete="off"
            placeholder={
              isToday ? "Přidat úkol, s časem „14:30 …“" : "Přidat, s časem „14:30 …“"
            }
            className="h-12 min-w-0 flex-1 bg-transparent text-[17px] outline-none placeholder:text-day-ink/60"
          />
          {draftTimed && (
            <span className="mr-2 shrink-0 whitespace-nowrap text-[13px] font-medium tabular-nums text-day-muted">
              v {draftTimed.time}
            </span>
          )}
          {draft.trim() && (
            <button
              type="submit"
              disabled={adding}
              className="h-9 shrink-0 rounded-full bg-day-ink px-3.5 text-sm font-medium text-day-bg disabled:opacity-60"
            >
              Přidat
            </button>
          )}
        </form>
      )}

      {loadError && (
        <LoadError
          onRetry={load}
          stale={items.length + cards.length > 0}
          message="Denní list se nepodařilo načíst."
        />
      )}

      {loading ? (
        <div aria-hidden className="-mt-2 flex flex-col gap-5 py-3">
          {[72, 54, 64].map((w) => (
            <div key={w} className="h-4 rounded bg-day-line" style={{ width: `${w}%` }} />
          ))}
        </div>
      ) : isPast ? (
        pastRows.length ? (
          <ul className="-mt-2">
            {pastRows.map((row) => (
              <PastRowView key={row.key} row={row} done={pastDone(row)} />
            ))}
          </ul>
        ) : (
          <p className="-mt-2 text-[15px] text-day-muted">{emptyText}</p>
        )
      ) : (
        <>
          {sections.length > 0 ? (
            <div className="-mt-4 flex flex-col gap-7">
              {sections.map((section) => (
                <section key={section.key} aria-label={section.label}>
                  {planned.length > 0 && (
                    <h2 className="mb-0.5 text-xs font-semibold uppercase tracking-[0.09em] text-day-muted">
                      {section.label}
                    </h2>
                  )}
                  <ul>
                    {section.rows.map((row) =>
                      row.kind === "card" ? (
                        <CardRowView
                          key={row.key}
                          row={row}
                          firm={tagOf(row.card.workspace_id)}
                          canOpen={mineIds.includes(row.card.workspace_id)}
                          onToggle={toggleCard}
                        />
                      ) : (
                        <ItemRowView
                          key={row.key}
                          row={row}
                          firm={tagOf(row.item.workspace_id)}
                          menuOpen={menuFor === row.item.id}
                          onToggle={toggleItem}
                          onMenu={(id) => setMenuFor((cur) => (cur === id ? null : id))}
                          onPromote={(item) => {
                            setMenuFor(null);
                            setPromoting(item);
                          }}
                          firmOptions={showFirms ? firms : null}
                          onFirm={changeFirm}
                          onTomorrow={isToday ? moveToTomorrow : null}
                          onRemove={remove}
                        />
                      )
                    )}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <p className="-mt-2 max-w-[440px] text-[15px] text-day-muted">{emptyText}</p>
          )}

          {doneRows.length > 0 && (
            <section aria-label="Hotové" className="-mt-2 flex flex-col">
              <button
                onClick={() => setShowDone((v) => !v)}
                aria-expanded={showDone}
                className="-ml-2.5 inline-flex h-11 items-center gap-1.5 self-start rounded-lg px-2.5 text-sm text-day-muted hover:text-day-ink"
              >
                Hotovo · {doneRows.length}
                <span className={`transition-transform ${showDone ? "rotate-180" : ""}`}>
                  <Icon d="M6 9l6 6 6-6" />
                </span>
              </button>
              {showDone && (
                <ul>
                  {doneRows.map((row) => {
                    const workspaceId =
                      row.kind === "item" ? row.item.workspace_id : row.card.workspace_id;
                    return (
                      <DoneRowView
                        key={row.key}
                        row={row}
                        firm={tagOf(workspaceId)}
                        firmName={firmOf(workspaceId).name}
                        canOpen={mineIds.includes(workspaceId)}
                        onToggleItem={toggleItem}
                        onToggleCard={toggleCard}
                      />
                    );
                  })}
                </ul>
              )}
            </section>
          )}
        </>
      )}

      <footer className="mt-6">
        <Link
          href="/"
          className="text-[13px] text-day-muted underline-offset-[3px] hover:underline"
        >
          Otevřít Kronos
        </Link>
      </footer>

      {promoting && (
        <PromoteDialog
          item={promoting}
          firmName={firmOf(promoting.workspace_id).name}
          onClose={closePromote}
          onSubmit={(title) => promote(promoting, title)}
        />
      )}
    </main>
  );
}

// ------------------------------------------------------------------ řádky

const ROW = "flex items-start gap-0.5 border-b border-day-line py-0.5";
const CHECK_BTN = "group -ml-[11px] flex size-11 shrink-0 items-center justify-center";
const TIME = "w-[50px] shrink-0 pt-[11px] text-[15px] leading-[1.4] tabular-nums";
const TEXT = "min-w-0 flex-1 py-2.5";
const TITLE = "break-words text-[17px] leading-[1.4]";
const META =
  "mt-[3px] flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm leading-[1.4] text-day-muted";
const PILL = "h-11 rounded-full border border-day-line px-4 text-sm hover:border-day-ink";
/** drobné akce v ⋯ — vejdou se na jeden řádek, žádná nevyčnívá */
const ACTION =
  "inline-flex h-9 items-center gap-1 rounded-full border border-day-line px-3 text-[13px] hover:border-day-ink";

function ItemRowView({
  row,
  firm,
  menuOpen,
  onToggle,
  onMenu,
  onPromote,
  firmOptions,
  onFirm,
  onTomorrow,
  onRemove,
}: {
  row: Extract<Row, { kind: "item" }>;
  /** vlaječka firmy; null = jediná firma, nic neukazovat */
  firm: Firm | null;
  menuOpen: boolean;
  onToggle: (item: DayItem) => void;
  onMenu: (id: string) => void;
  onPromote: (item: DayItem) => void;
  /** firmy na výběr; null = jediná firma, není co měnit */
  firmOptions: DayFirm[] | null;
  onFirm: (item: DayItem, workspaceId: string) => void;
  onTomorrow: ((item: DayItem) => void) | null;
  onRemove: (item: DayItem) => void;
}) {
  const { item, time, carried } = row;
  const agent = item.source === "agent";
  const hasMeta = !!firm || agent || !!carried || !!item.note || !!item.link_url;
  return (
    <li className={ROW}>
      <button
        onClick={() => onToggle(item)}
        aria-label={`Odškrtnout: ${item.title}`}
        className={CHECK_BTN}
      >
        <span className="block size-[22px] rounded-full border-[1.5px] border-day-faint group-hover:border-day-ink" />
      </button>
      {time && <span className={`${TIME} font-semibold`}>{time}</span>}
      <div className={TEXT}>
        <p className={TITLE}>{item.title}</p>
        {hasMeta && (
          <p className={META}>
            {firm && <FirmTag firm={firm} />}
            {agent && <AgentMark />}
            {carried && <span className="font-medium text-day-brass">{carried}</span>}
            {item.note && <span className="break-words">{item.note}</span>}
            {item.link_url && <ItemLink item={item} />}
          </p>
        )}
        {menuOpen && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <button onClick={() => onPromote(item)} className={ACTION}>
              <Icon d="M7 17L17 7M8 7h9v9" size={13} />
              Udělat kartu v Kronosu
            </button>
            {firmOptions && (
              <FirmPicker
                firms={firmOptions}
                value={item.workspace_id}
                onChange={(id) => onFirm(item, id)}
                triggerClass={ACTION}
              />
            )}
            {onTomorrow && (
              <button onClick={() => onTomorrow(item)} className={ACTION}>
                Na zítra
              </button>
            )}
            <button onClick={() => onRemove(item)} className={ACTION}>
              Smazat
            </button>
          </div>
        )}
      </div>
      <button
        onClick={() => onMenu(item.id)}
        aria-label={`Akce: ${item.title}`}
        aria-expanded={menuOpen}
        className="-mr-[11px] flex size-11 shrink-0 items-center justify-center rounded-lg text-day-faint hover:text-day-ink"
      >
        <svg viewBox="0 0 24 24" className="size-5" fill="currentColor" aria-hidden>
          <circle cx="5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>
    </li>
  );
}

/** Karta z Mého dne (kteréhokoli propojeného účtu): odškrtnutí ji dokončí. */
function CardRowView({
  row,
  firm,
  canOpen,
  onToggle,
}: {
  row: Extract<Row, { kind: "card" }>;
  firm: Firm | null;
  canOpen: boolean;
  onToggle: (card: PlannedCard) => void;
}) {
  const { card, time } = row;
  return (
    <li className={ROW}>
      <button
        onClick={() => onToggle(card)}
        aria-label={`Dokončit kartu: ${card.title}`}
        className={CHECK_BTN}
      >
        <span className="block size-[22px] rounded-full border-[1.5px] border-day-faint group-hover:border-day-ink" />
      </button>
      <span className={`${TIME} font-semibold`}>{time}</span>
      <div className={TEXT}>
        <p className={TITLE}>{card.title}</p>
        <CardMeta card={card} firm={firm} canOpen={canOpen} />
      </div>
    </li>
  );
}

function CardMeta({
  card,
  firm,
  canOpen,
}: {
  card: PlannedCard;
  firm: Firm | null;
  canOpen: boolean;
}) {
  return (
    <p className={META}>
      <span title="Karta z Mého dne" className="inline-flex">
        <NavIcon d={ICONS.board} className="size-[14px]" />
      </span>
      {firm && <FirmTag firm={firm} />}
      {card.project_name && <span>{card.project_name}</span>}
      {/* kartu jiné firmy přihlášený účet neotevře (RLS) */}
      {canOpen && (
        <Link
          href={`/t/${card.id}`}
          className="inline-flex items-center gap-0.5 text-day-ink underline decoration-day-faint underline-offset-[3px]"
        >
          karta
          <Icon d="M7 17L17 7M8 7h9v9" size={13} />
        </Link>
      )}
    </p>
  );
}

function DoneRowView({
  row,
  firm,
  firmName,
  canOpen,
  onToggleItem,
  onToggleCard,
}: {
  row: Row;
  firm: Firm | null;
  firmName: string;
  /** přihlášený účet je ve firmě řádku — kartu jde otevřít */
  canOpen: boolean;
  onToggleItem: (item: DayItem) => void;
  onToggleCard: (card: PlannedCard) => void;
}) {
  const converted = row.kind === "item" && !!row.item.task_id;
  const title = row.kind === "item" ? row.item.title : row.card.title;
  return (
    <li className={ROW}>
      {converted ? (
        <span aria-hidden className="-ml-[11px] flex size-11 shrink-0 items-center justify-center">
          <span className="flex size-[22px] items-center justify-center rounded-full bg-day-ink text-day-bg">
            <Icon d="M7 17L17 7M8 7h9v9" size={13} strokeWidth={2.6} />
          </span>
        </span>
      ) : (
        <button
          onClick={() =>
            row.kind === "item" ? onToggleItem(row.item) : onToggleCard(row.card)
          }
          aria-label={
            row.kind === "item"
              ? `Vrátit mezi nehotové: ${title}`
              : `Znovu otevřít kartu: ${title}`
          }
          className={CHECK_BTN}
        >
          <span className="flex size-[22px] items-center justify-center rounded-full bg-day-muted text-day-bg">
            <Icon d="M5 12.5l4.5 4.5L19 7" size={14} strokeWidth={3} />
          </span>
        </button>
      )}
      {row.time && <span className={`${TIME} font-medium text-day-muted`}>{row.time}</span>}
      <div className={TEXT}>
        <p className={`${TITLE} text-day-muted ${converted ? "" : "line-through"}`}>{title}</p>
        {converted && row.kind === "item" && (
          <p className={META}>
            <span>Karta v Inboxu {firmName}</span>
            {canOpen ? (
              <Link
                href={`/t/${row.item.task_id}`}
                className="text-day-ink underline-offset-[3px] hover:underline"
              >
                otevřít v Kronosu
              </Link>
            ) : (
              <span>· otevřeš pod jejím účtem</span>
            )}
          </p>
        )}
        {row.kind === "card" && <CardMeta card={row.card} firm={firm} canOpen={canOpen} />}
      </div>
    </li>
  );
}

/** Minulý den — jen ke čtení: co se stihlo a co přešlo dál. */
function PastRowView({ row, done }: { row: Row; done: boolean }) {
  const title = row.kind === "item" ? row.item.title : row.card.title;
  return (
    <li className={ROW}>
      <span aria-hidden className="-ml-[11px] flex size-11 shrink-0 items-center justify-center">
        {done ? (
          <span className="flex size-[22px] items-center justify-center rounded-full bg-day-muted text-day-bg">
            <Icon d="M5 12.5l4.5 4.5L19 7" size={14} strokeWidth={3} />
          </span>
        ) : (
          <span className="flex size-[22px] items-center justify-center rounded-full border-[1.5px] border-day-brass text-day-brass">
            <Icon d="M5 12h14M13 6l6 6-6 6" size={14} strokeWidth={2.4} />
          </span>
        )}
      </span>
      {row.time && <span className={`${TIME} font-medium text-day-muted`}>{row.time}</span>}
      <div className={TEXT}>
        <p className={`${TITLE} text-day-muted ${done ? "line-through" : ""}`}>
          <span className="sr-only">{done ? "Hotovo: " : "Nedodělané: "}</span>
          {title}
        </p>
        {!done && (
          <p className="mt-[3px] text-sm font-medium text-day-brass">
            {row.kind === "card" ? "Karta zůstala otevřená" : "Nedodělané — přešlo na další den"}
          </p>
        )}
      </div>
    </li>
  );
}

// ------------------------------------------------------------- drobnosti

function FirmTag({ firm }: { firm: Firm }) {
  return <span>{firm.name}</span>;
}

/** Výběr firmy — vlastní malá nabídka místo nativního <select> (ten
    vypadá v každém prohlížeči jinak a ruší). Zavře ji výběr, klik mimo
    i Esc. */
function FirmPicker({
  firms,
  value,
  onChange,
  triggerClass,
}: {
  firms: DayFirm[];
  value: string;
  onChange: (workspaceId: string) => void;
  triggerClass: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = firms.find((f) => f.workspace_id === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Firma: ${current?.name ?? "?"}`}
        className={triggerClass}
      >
        {current?.name ?? "?"}
        <span className={`transition-transform ${open ? "rotate-180" : ""}`}>
          <Icon d="M6 9l6 6 6-6" size={13} />
        </span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Firma"
          className="absolute left-0 top-full z-20 mt-1 flex w-max min-w-full flex-col rounded-xl border border-day-line bg-white p-1 shadow-[0_8px_24px_rgba(0,0,0,0.12)]"
        >
          {firms.map((f) => {
            const selected = f.workspace_id === value;
            return (
              <button
                key={f.workspace_id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  onChange(f.workspace_id);
                  setOpen(false);
                }}
                className={`flex items-center justify-between gap-4 rounded-lg px-3 py-2 text-left text-[13px] hover:bg-day-bg ${
                  selected ? "font-semibold" : ""
                }`}
              >
                {f.name}
                <span className={selected ? "" : "invisible"}>
                  <Icon d="M5 12.5l4.5 4.5L19 7" size={13} strokeWidth={2.4} />
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ItemLink({ item }: { item: DayItem }) {
  return (
    <a
      href={item.link_url!}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-0.5 text-day-ink underline decoration-day-faint underline-offset-[3px]"
    >
      {linkLabel(item)}
      <Icon d="M7 17L17 7M8 7h9v9" size={13} />
    </a>
  );
}

function AgentMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-[13px]" fill="currentColor" role="img" aria-label="Navrhl agent">
      <title>Navrhl agent</title>
      <path d="M12 2.5l2.1 6.6 6.6 2.1-6.6 2.1-2.1 6.6-2.1-6.6-6.6-2.1 6.6-2.1z" />
    </svg>
  );
}

function Icon({ d, size = 16, strokeWidth = 2 }: { d: string; size?: number; strokeWidth?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

// ---------------------------------------------------------------- převod

function PromoteDialog({
  item,
  firmName,
  onClose,
  onSubmit,
}: {
  item: DayItem;
  firmName: string;
  onClose: () => void;
  onSubmit: (title: string) => Promise<boolean>;
}) {
  const [title, setTitle] = useState(item.title);
  const [saving, setSaving] = useState(false);
  const description = [item.note, item.link_url].filter(Boolean).join(" · ");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const name = title.trim();
    if (!name || saving) return;
    setSaving(true);
    const created = await onSubmit(name);
    setSaving(false);
    if (created) onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="promote-title"
        className="flex w-full max-w-[460px] flex-col gap-[18px] rounded-[18px] bg-white p-6 shadow-[0_24px_64px_rgba(0,0,0,0.22)]"
      >
        <h2
          id="promote-title"
          className="font-day-display text-2xl font-[650] tracking-[-0.015em]"
        >
          Udělat kartu v Kronosu
        </h2>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="promote-name" className="text-[13px] text-day-muted">
            Název karty
          </label>
          <input
            id="promote-name"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={500}
            autoFocus
            className="h-11 rounded-[10px] border border-day-line bg-day-bg px-3 text-base"
          />
        </div>
        {description && (
          <div className="flex flex-col gap-1">
            <p className="text-[13px] text-day-muted">Popis karty</p>
            <p className="break-words text-[15px]">{description}</p>
          </div>
        )}
        <p className="text-sm text-day-muted">
          Karta přistane v Inboxu {firmName} a roztřídíš ji tam jako každou jinou. Položka
          tady se odškrtne a bude na kartu odkazovat.
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className={PILL}>
            Zrušit
          </button>
          <button
            type="submit"
            disabled={saving || !title.trim()}
            className="h-11 rounded-full bg-day-accent px-[18px] text-sm font-semibold text-white disabled:opacity-60"
          >
            {saving ? "Zakládám…" : "Vytvořit kartu"}
          </button>
        </div>
      </form>
    </div>
  );
}
