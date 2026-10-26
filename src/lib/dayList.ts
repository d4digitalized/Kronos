import type { SupabaseClient } from "@supabase/supabase-js";
import type { DayFirm, DayItem, PlannedCard } from "@/lib/types";

// Denní list (/den): data a popisky dnů sdílené stránkou, klientským view
// i MCP nástroji. Den = "YYYY-MM-DD" v Europe/Prague; v URL zkráceně YY-MM-DD.

const WEEKDAYS = ["Pondělí", "Úterý", "Středa", "Čtvrtek", "Pátek", "Sobota", "Neděle"];
const WEEKDAYS_SHORT = ["po", "út", "st", "čt", "pá", "so", "ne"];
/** „od pátku" — 2. pád */
const WEEKDAYS_FROM = ["pondělí", "úterý", "středy", "čtvrtka", "pátku", "soboty", "neděle"];
const MONTHS = [
  "ledna",
  "února",
  "března",
  "dubna",
  "května",
  "června",
  "července",
  "srpna",
  "září",
  "října",
  "listopadu",
  "prosince",
];

const DAY_MS = 86_400_000;

/** Dnešek v Europe/Prague (server běží v UTC). */
export function pragueToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Prague",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function utc(day: string): number {
  return Date.parse(`${day}T12:00:00Z`);
}

export function addDays(day: string, n: number): string {
  return new Date(utc(day) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Kolik dní je `to` po `from` (záporné = před). */
export function daysBetween(from: string, to: string): number {
  return Math.round((utc(to) - utc(from)) / DAY_MS);
}

/** 0 = pondělí … 6 = neděle */
function weekday(day: string): number {
  return (new Date(utc(day)).getUTCDay() + 6) % 7;
}

function dayMonth(day: string): [number, number] {
  return [Number(day.slice(8, 10)), Number(day.slice(5, 7))];
}

/** URL segment „26-10-26" (nebo i celé „2026-10-26") → den; null = nesmysl. */
export function dayFromSlug(slug: string): string | null {
  const m = /^(\d{2}|\d{4})-(\d{2})-(\d{2})$/.exec(slug);
  if (!m) return null;
  const day = `${m[1].length === 2 ? `20${m[1]}` : m[1]}-${m[2]}-${m[3]}`;
  // měsíc 13 → NaN; 26-02-31 apod. by Date tiše přetočil na březen
  if (Number.isNaN(utc(day))) return null;
  return addDays(day, 0) === day ? day : null;
}

/** Odkaz na den; dnešek má jednu stálou adresu /den. */
export function dayHref(day: string, today: string): string {
  return day === today ? "/den" : `/den/${day.slice(2)}`;
}

/** Hlavička: „Pondělí" + „Dnes · 26. října". */
export function dayHeading(day: string, today: string): { weekday: string; date: string } {
  const diff = daysBetween(today, day);
  const prefix =
    diff === 0 ? "Dnes · " : diff === 1 ? "Zítra · " : diff === -1 ? "Včera · " : "";
  const [d, m] = dayMonth(day);
  const year = day.slice(0, 4) !== today.slice(0, 4) ? ` ${day.slice(0, 4)}` : "";
  return { weekday: WEEKDAYS[weekday(day)], date: `${prefix}${d}. ${MONTHS[m - 1]}${year}` };
}

/** Šipky mezi dny: „pá 23. 10." */
export function dayShort(day: string): string {
  const [d, m] = dayMonth(day);
  return `${WEEKDAYS_SHORT[weekday(day)]} ${d}. ${m}.`;
}

/** Štítek přenesené položky: „od včera", „od pátku", „od 12. 10.". */
export function carriedLabel(from: string, today: string): string {
  const diff = daysBetween(from, today);
  if (diff === 1) return "od včera";
  if (diff < 7) return `od ${WEEKDAYS_FROM[weekday(from)]}`;
  const [d, m] = dayMonth(from);
  return `od ${d}. ${m}.`;
}

/** „14:30 Zavolat Pepovi" → { time: "14:30", title: "Zavolat Pepovi" }. */
export function parseTimePrefix(text: string): { time: string; title: string } | null {
  const m = /^(\d{1,2})[:.](\d{2})\s+(\S[\s\S]*)$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  if (h > 23 || Number(m[2]) > 59) return null;
  return { time: `${String(h).padStart(2, "0")}:${m[2]}`, title: m[3].trim() };
}

/** DB `time` „14:30:00" → „14:30". */
export function hhmm(at: string | null): string | null {
  return at ? at.slice(0, 5) : null;
}

/** Popisek odkazu, když ho agent nedal: „mail" / doména. */
export function linkLabel(item: Pick<DayItem, "link_url" | "link_label">): string {
  if (item.link_label) return item.link_label;
  const url = item.link_url ?? "";
  if (url.startsWith("mailto:")) return "mail";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "odkaz";
  }
}

/** Firmy propojené skupiny účtů (migrace 0054): domovská první, pak
    abecedně. `missing` = funkce v DB chybí (migrace ještě neběží). */
export async function loadDayFirms(
  client: SupabaseClient
): Promise<{ firms: DayFirm[]; error: string | null; missing: boolean }> {
  const { data, error } = await client.rpc("daylist_firms");
  if (error)
    return { firms: [], error: error.message, missing: error.code === "PGRST202" };
  const firms = ((data ?? []) as DayFirm[]).sort(
    (a, b) => Number(b.is_home) - Number(a.is_home) || a.name.localeCompare(b.name, "cs")
  );
  return { firms, error: null, missing: false };
}

/** Výchozí firma nové položky: domovská (u propojených účtů firma vlastníka). */
export function defaultFirmId(firms: DayFirm[]): string | null {
  return (firms.find((f) => f.is_home) ?? firms[0])?.workspace_id ?? null;
}

/** Položky dne celé skupiny (RLS vrací položky všech propojených účtů).
    Dnešek si přibere i starší nehotové (přenos nedodělaných se nezapisuje —
    děje se tady) a starší dokončené dnes. */
export function queryDayItems(
  client: SupabaseClient,
  day: string,
  today: string,
  /** začátek dne `day` jako ISO (půlnoc v Europe/Prague) */
  dayStartISO: string
) {
  let q = client.from("day_items").select("*");
  q =
    day === today
      ? q.or(
          `day.eq.${day},and(day.lt.${day},done_at.is.null),and(day.lt.${day},done_at.gte."${dayStartISO}")`
        )
      : q.eq("day", day);
  return q.order("day").order("created_at");
}

/** Karty naplánované na den v Mém dni všech propojených účtů — výběr jako
    Můj den (řeším je, nebo jsem autor bez řešitelů). */
export async function loadPlannedCards(
  client: SupabaseClient,
  fromISO: string,
  toISO: string
): Promise<{ cards: PlannedCard[]; error: string | null }> {
  const { data, error } = await client.rpc("daylist_planned_cards", {
    p_from: fromISO,
    p_to: toISO,
  });
  if (error) return { cards: [], error: error.message };
  return { cards: (data ?? []) as PlannedCard[], error: null };
}

/** Odškrtnutí / vrácení karty z denního listu — jde z kteréhokoli účtu
    skupiny; zapíše se pod účtem, kterému karta patří. Vrací completed_at. */
export async function setCardDone(
  client: SupabaseClient,
  taskId: string,
  done: boolean
): Promise<{ completedAt: string | null; error: string | null }> {
  const { data, error } = await client.rpc("daylist_set_card_done", {
    p_task_id: taskId,
    p_done: done,
  });
  if (error) return { completedAt: null, error: error.message };
  return { completedAt: (data as string | null) ?? null, error: null };
}
