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
  hhmm,
  linkLabel,
  loadPlannedCards,
  parseTimePrefix,
  queryDayItems,
} from "@/lib/dayList";
import type { DayItem, PlannedCard, Workspace } from "@/lib/types";

// poslední firma, do které šla karta z položky (per prohlížeč)
const FIRM_KEY = "kronos:daylist-firm";

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
    Nedodělané z minulých dnů se přiberou při načtení dneška (nic se
    nepřesouvá), karty z Mého dne se přimíchají mezi Naplánované. */
export default function DayListView({
  userId,
  day,
  today,
  firms,
}: {
  userId: string;
  day: string;
  today: string;
  /** firmy, kde smím zakládat karty (cíl převodu položky) */
  firms: Workspace[];
}) {
  const supabase = createClient();
  const [items, setItems] = useState<DayItem[]>([]);
  const [cards, setCards] = useState<PlannedCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // pořadí načítání: starší odpověď nesmí přepsat novější
  const loadSeq = useRef(0);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [promoting, setPromoting] = useState<DayItem | null>(null);

  const isToday = day === today;
  const isPast = day < today;
  const heading = dayHeading(day, today);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const start = dayStartISO(day);
    const end = dayStartISO(addDays(day, 1));
    const [itemsRes, cardsRes] = await Promise.all([
      queryDayItems(supabase, userId, day, today, start),
      loadPlannedCards(supabase, userId, start, end),
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
  }, [supabase, userId, day, today]);

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
    const completed_at = card.completed_at ? null : new Date().toISOString();
    const setCompleted = (value: string | null) =>
      setCards((list) =>
        list.map((c) => (c.id === card.id ? { ...c, completed_at: value } : c))
      );
    setCompleted(completed_at);
    const { error } = await supabase
      .from("tasks")
      .update({ completed_at })
      .eq("id", card.id);
    if (error) {
      setCompleted(card.completed_at);
      toast("Kartu se nepodařilo uložit.", "error");
      return;
    }
    if (completed_at) pingNotifyEmails(); // opakovaná karta může přiřadit další výskyt
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || adding) return;
    const timed = parseTimePrefix(text);
    setAdding(true);
    const { data, error } = await supabase
      .from("day_items")
      .insert({ day, at: timed?.time ?? null, title: timed?.title ?? text, source: "me" })
      .select("*")
      .single();
    setAdding(false);
    if (error || !data) {
      toast("Položku se nepodařilo přidat.", "error");
      return;
    }
    setItems((list) => [...list, data as DayItem]);
    setDraft("");
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

  /** Karta v Inboxu vybrané firmy; položka se odškrtne a odkáže na ni. */
  async function promote(item: DayItem, title: string, firm: Workspace): Promise<boolean> {
    const description = [item.note, item.link_url].filter(Boolean).join("\n\n");
    const { data: task, error } = await supabase
      .from("tasks")
      .insert({
        workspace_id: firm.id,
        project_id: null,
        column_id: null,
        title,
        description,
        position: 0,
      })
      .select("id")
      .single();
    if (error || !task) {
      toast("Kartu se nepodařilo založit.", "error");
      return false;
    }
    try {
      localStorage.setItem(FIRM_KEY, firm.id);
    } catch {}
    const done_at = new Date().toISOString();
    const { error: linkError } = await supabase
      .from("day_items")
      .update({ done_at, task_id: task.id })
      .eq("id", item.id);
    if (linkError) {
      toast("Karta vznikla, ale položku se nepodařilo odškrtnout.", "error");
      load();
      return true;
    }
    patchItem(item.id, {
      done_at,
      task_id: task.id as string,
      tasks: { workspaces: { name: firm.name } },
    });
    setShowDone(true);
    toast(`Karta je v Inboxu ${firm.name}.`);
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
    const row: Row = {
      kind: "card",
      key: card.id,
      time: localHHMM(card.planned_start!),
      card,
    };
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
          <label htmlFor="day-new" className="sr-only">
            Nový úkol
          </label>
          <span
            aria-hidden
            className="flex h-12 w-11 shrink-0 items-center justify-center text-day-muted"
          >
            <Icon d="M12 5v14M5 12h14" size={20} />
          </span>
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
                        <CardRowView key={row.key} row={row} onToggle={toggleCard} />
                      ) : (
                        <ItemRowView
                          key={row.key}
                          row={row}
                          menuOpen={menuFor === row.item.id}
                          onToggle={toggleItem}
                          onMenu={(id) => setMenuFor((cur) => (cur === id ? null : id))}
                          onPromote={
                            firms.length
                              ? (item) => {
                                  setMenuFor(null);
                                  setPromoting(item);
                                }
                              : null
                          }
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
                  {doneRows.map((row) => (
                    <DoneRowView
                      key={row.key}
                      row={row}
                      onToggleItem={toggleItem}
                      onToggleCard={toggleCard}
                    />
                  ))}
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
          firms={firms}
          onClose={closePromote}
          onSubmit={(title, firm) => promote(promoting, title, firm)}
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

function ItemRowView({
  row,
  menuOpen,
  onToggle,
  onMenu,
  onPromote,
  onTomorrow,
  onRemove,
}: {
  row: Extract<Row, { kind: "item" }>;
  menuOpen: boolean;
  onToggle: (item: DayItem) => void;
  onMenu: (id: string) => void;
  onPromote: ((item: DayItem) => void) | null;
  onTomorrow: ((item: DayItem) => void) | null;
  onRemove: (item: DayItem) => void;
}) {
  const { item, time, carried } = row;
  const agent = item.source === "agent";
  const hasMeta = agent || !!carried || !!item.note || !!item.link_url;
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
            {agent && <AgentMark />}
            {carried && <span className="font-medium text-day-brass">{carried}</span>}
            {item.note && <span className="break-words">{item.note}</span>}
            {item.link_url && <ItemLink item={item} />}
          </p>
        )}
        {menuOpen && (
          <div className="mt-3 flex flex-wrap gap-2">
            {onPromote && (
              <button
                onClick={() => onPromote(item)}
                className="inline-flex h-11 items-center gap-1.5 rounded-full bg-day-ink px-4 text-sm font-medium text-day-bg"
              >
                <Icon d="M7 17L17 7M8 7h9v9" size={15} />
                Udělat kartu v Kronosu
              </button>
            )}
            {onTomorrow && (
              <button onClick={() => onTomorrow(item)} className={PILL}>
                Na zítra
              </button>
            )}
            <button onClick={() => onRemove(item)} className={PILL}>
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

/** Karta z Mého dne: odškrtnutí ji v Kronosu dokončí. */
function CardRowView({
  row,
  onToggle,
}: {
  row: Extract<Row, { kind: "card" }>;
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
        <CardMeta card={card} />
      </div>
    </li>
  );
}

function CardMeta({ card }: { card: PlannedCard }) {
  const where = [card.workspaces?.name, card.projects?.name].filter(Boolean).join(" · ");
  return (
    <p className={META}>
      <span title="Karta z Mého dne" className="inline-flex">
        <NavIcon d={ICONS.board} className="size-[14px]" />
      </span>
      {where && <span>{where}</span>}
      <Link
        href={`/t/${card.id}`}
        className="inline-flex items-center gap-0.5 text-day-ink underline decoration-day-faint underline-offset-[3px]"
      >
        karta
        <Icon d="M7 17L17 7M8 7h9v9" size={13} />
      </Link>
    </p>
  );
}

function DoneRowView({
  row,
  onToggleItem,
  onToggleCard,
}: {
  row: Row;
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
            <span>
              {row.item.tasks?.workspaces?.name
                ? `Karta v Inboxu ${row.item.tasks.workspaces.name}`
                : "Karta v Kronosu"}
            </span>
            <Link
              href={`/t/${row.item.task_id}`}
              className="text-day-ink underline-offset-[3px] hover:underline"
            >
              otevřít v Kronosu
            </Link>
          </p>
        )}
        {row.kind === "card" && <CardMeta card={row.card} />}
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
  firms,
  onClose,
  onSubmit,
}: {
  item: DayItem;
  firms: Workspace[];
  onClose: () => void;
  onSubmit: (title: string, firm: Workspace) => Promise<boolean>;
}) {
  const [title, setTitle] = useState(item.title);
  const [firmId, setFirmId] = useState(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(FIRM_KEY);
    } catch {}
    return firms.find((f) => f.id === saved)?.id ?? firms[0].id;
  });
  const [saving, setSaving] = useState(false);
  const firm = firms.find((f) => f.id === firmId) ?? firms[0];
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
    const created = await onSubmit(name, firm);
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
        {firms.length > 1 && (
          <fieldset className="min-w-0">
            <legend className="mb-2 text-[13px] text-day-muted">Firma</legend>
            <div className="flex flex-wrap gap-2">
              {firms.map((f) => {
                const selected = f.id === firm.id;
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setFirmId(f.id)}
                    aria-pressed={selected}
                    className={`h-11 rounded-full border px-4 text-sm font-medium ${
                      selected
                        ? "border-day-ink bg-day-ink text-day-bg"
                        : "border-day-line hover:border-day-ink"
                    }`}
                  >
                    {f.name}
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}
        <p className="text-sm text-day-muted">
          Karta přistane v Inboxu {firms.length > 1 ? "vybrané firmy" : firm.name} a
          roztřídíš ji tam jako každou jinou. Položka tady se odškrtne a bude na kartu
          odkazovat.
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
