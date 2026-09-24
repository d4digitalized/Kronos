import type { PostgrestError } from "@supabase/supabase-js";

// Supabase (PostgREST „Max rows") vrátí na jeden dotaz nejvýš 1000 řádků
// a zbytek TIŠE zahodí — přehled za delší období by přišel o náhodné
// záznamy a součty by neseděly. Stránkujeme po 1000 (výchozí limit).
const PAGE = 1000;

type Page = PromiseLike<{ data: unknown[] | null; error: PostgrestError | null }>;

/** Stáhne všechny stránky dotazu. `page(from, to)` = dotaz s `.range(from, to)`
    a STABILNÍM řazením (např. started_at + id), jinak se stránky překryjí. */
export async function fetchAllRows<T>(
  page: (from: number, to: number) => Page
): Promise<{ data: T[]; error: PostgrestError | null }> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) return { data: all, error };
    const rows = (data ?? []) as T[];
    all.push(...rows);
    if (rows.length < PAGE) return { data: all, error: null };
  }
}
