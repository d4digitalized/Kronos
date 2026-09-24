"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/fetchAll";
import { entrySeconds, fmtDuration, fmtTime } from "@/lib/format";
import { ProjectDot } from "@/components/ProjectPicker";
import Avatar from "@/components/Avatar";
import type { TimeEntry } from "@/lib/types";

type Props = {
  wsId: string;
  userId: string;
  from: string;
  to: string;
  rate: number | null;
  unit: "hod" | "mesic";
};

const CZK = new Intl.NumberFormat("cs-CZ", {
  style: "currency",
  currency: "CZK",
  maximumFractionDigits: 0,
});

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString("cs-CZ", {
    day: "numeric",
    month: "numeric",
    year: "numeric",
  });
}

/** „Červen 2026" pro celý kalendářní měsíc, jinak „1. 6. 2026 – 15. 6. 2026" */
function periodLabel(from: string, to: string): string {
  const f = new Date(`${from}T00:00`);
  const t = new Date(`${to}T00:00`);
  const lastDay = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  if (
    f.getDate() === 1 &&
    t.getDate() === lastDay &&
    f.getMonth() === t.getMonth() &&
    f.getFullYear() === t.getFullYear()
  ) {
    const month = f.toLocaleDateString("cs-CZ", { month: "long", year: "numeric" });
    return month.charAt(0).toUpperCase() + month.slice(1);
  }
  return `${f.toLocaleDateString("cs-CZ")} – ${t.toLocaleDateString("cs-CZ")}`;
}

export default function VykazView({ wsId, userId, from, to, rate, unit }: Props) {
  const supabase = createClient();
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [person, setPerson] = useState<{
    full_name: string;
    email: string;
    avatar_initials?: string;
    avatar_color?: string;
  } | null>(null);
  const [wsName, setWsName] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    const toExclusive = new Date(`${to}T00:00`);
    toExclusive.setDate(toExclusive.getDate() + 1);
    const [entriesRes, profileRes, wsRes] = await Promise.all([
      // všechny stránky — výkaz za delší období má víc než 1000 záznamů
      fetchAllRows<TimeEntry>((a, b) =>
        supabase
          .from("time_entries")
          .select("id, started_at, stopped_at, description, project_id, projects(name, position), tasks(title)")
          .eq("workspace_id", wsId)
          .eq("user_id", userId)
          .not("stopped_at", "is", null)
          .gte("started_at", new Date(`${from}T00:00`).toISOString())
          .lt("started_at", toExclusive.toISOString())
          .order("started_at", { ascending: true })
          .order("id")
          .range(a, b)
      ),
      supabase
        .from("profiles")
        .select("full_name, email, avatar_initials, avatar_color")
        .eq("id", userId)
        .single(),
      supabase.from("workspaces").select("name").eq("id", wsId).single(),
    ]);
    // nepovedené načtení nesmí vytisknout výkaz s nulou hodin
    setLoadError(!!entriesRes.error);
    setEntries(entriesRes.data);
    setPerson(profileRes.data ?? null);
    setWsName(wsRes.data?.name ?? "");
    setLoading(false);
  }, [supabase, wsId, userId, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return <p className="p-8 text-ink-soft/70">Připravuji výkaz…</p>;
  }
  if (loadError) {
    return (
      <p className="flex flex-wrap items-center gap-2 p-8 text-sm text-danger">
        Výkaz se nepodařilo načíst.
        <button onClick={load} className="rounded-md px-2 py-1 text-xs underline">
          Zkusit znovu
        </button>
      </p>
    );
  }

  const totalSeconds = entries.reduce(
    (sum, e) => sum + entrySeconds(e.started_at, e.stopped_at),
    0
  );
  const totalHours = totalSeconds / 3600;

  const byProject = new Map<
    string,
    { id: string | null; name: string; seconds: number; position: number }
  >();
  for (const entry of entries) {
    const key = entry.project_id ?? "";
    const agg = byProject.get(key) ?? {
      id: entry.project_id ?? null,
      name: entry.projects?.name ?? "Bez projektu",
      seconds: 0,
      // „Bez projektu" poslední; pořadí projektů podle nastavení admina
      position: entry.project_id ? entry.projects?.position ?? Number.MAX_SAFE_INTEGER : Infinity,
    };
    agg.seconds += entrySeconds(entry.started_at, entry.stopped_at);
    byProject.set(key, agg);
  }

  const amount = rate === null ? null : unit === "hod" ? rate * totalHours : rate;
  const personName = person?.full_name || person?.email || "?";

  return (
    <div className="min-h-screen bg-paper print:bg-white">
      <div className="mx-auto flex max-w-[210mm] flex-col gap-2 px-4 pt-6 sm:flex-row sm:items-center sm:justify-between sm:px-8 print:hidden">
        <p className="text-sm text-ink-soft">
          Náhled výkazu — PDF uložíš tlačítkem vpravo (cíl „Uložit jako PDF“).
        </p>
        <button onClick={() => window.print()} className="btn-primary shrink-0">
          Uložit jako PDF
        </button>
      </div>

      <div className="mx-auto my-6 max-w-[210mm] bg-white p-5 shadow-sm sm:p-10 print:my-0 print:max-w-none print:p-0 print:shadow-none">
        <header className="flex items-baseline justify-between border-b-2 border-ink pb-3">
          <h1 className="font-display text-2xl font-semibold">Pracovní výkaz</h1>
          <span className="text-lg">{periodLabel(from, to)}</span>
        </header>

        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-ink-soft">Pracovník</dt>
          <dd className="flex items-center gap-2 font-medium">
            <Avatar profile={person} colorKey={userId} size="sm" />
            {personName}
            {person?.full_name && person?.email ? (
              <span className="font-normal text-ink-soft"> · {person.email}</span>
            ) : null}
          </dd>
          <dt className="text-ink-soft">Workspace</dt>
          <dd>{wsName}</dd>
          <dt className="text-ink-soft">Období</dt>
          <dd>
            {fmtDay(`${from}T00:00`)} – {fmtDay(`${to}T00:00`)}
          </dd>
          <dt className="text-ink-soft">Vystaveno</dt>
          <dd>{new Date().toLocaleDateString("cs-CZ")}</dd>
        </dl>

        {entries.length === 0 ? (
          <p className="mt-8 text-sm text-ink-soft">
            Za zvolené období nejsou žádné dokončené záznamy času.
          </p>
        ) : (
          <div className="overflow-x-auto scroll-touch print:overflow-visible">
          <table className="mt-6 w-full min-w-[34rem] border-collapse text-sm print:min-w-0">
            <thead>
              <tr className="border-b border-ink text-left text-xs uppercase tracking-wide text-ink-soft">
                <th className="py-1.5 pr-3 font-medium">Datum</th>
                <th className="py-1.5 pr-3 font-medium">Projekt</th>
                <th className="py-1.5 pr-3 font-medium">Popis</th>
                <th className="py-1.5 pr-3 font-medium">Od–Do</th>
                <th className="py-1.5 text-right font-medium">Hodiny</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-b border-line/70">
                  <td className="whitespace-nowrap py-1.5 pr-3">
                    {fmtDay(entry.started_at)}
                  </td>
                  <td className="py-1.5 pr-3">
                    <span className="inline-flex items-center gap-1.5">
                      <ProjectDot id={entry.project_id ?? null} />
                      {entry.projects?.name ?? "Bez projektu"}
                    </span>
                  </td>
                  <td className="py-1.5 pr-3">
                    {entry.tasks?.title || entry.description || "—"}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-ink-soft">
                    {fmtTime(entry.started_at)} – {entry.stopped_at ? fmtTime(entry.stopped_at) : ""}
                  </td>
                  <td className="py-1.5 text-right font-mono tabular-nums">
                    {fmtDuration(entrySeconds(entry.started_at, entry.stopped_at))}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-ink font-medium">
                <td colSpan={4} className="py-2 pr-3">
                  Celkem
                </td>
                <td className="py-2 text-right font-mono tabular-nums">
                  {fmtDuration(totalSeconds)} h
                </td>
              </tr>
            </tfoot>
          </table>
          </div>
        )}

        {byProject.size > 1 && (
          <section className="mt-6">
            <h2 className="text-xs font-medium uppercase tracking-wide text-ink-soft">
              Souhrn po projektech
            </h2>
            <table className="mt-1 w-auto min-w-64 text-sm">
              <tbody>
                {[...byProject.values()]
                  .sort((a, b) => a.position - b.position || b.seconds - a.seconds)
                  .map((project) => (
                    <tr key={project.id ?? "none"} className="border-b border-line/50 last:border-0">
                      <td className="py-1 pr-8">
                        <span className="inline-flex items-center gap-1.5">
                          <ProjectDot id={project.id} />
                          {project.name}
                        </span>
                      </td>
                      <td className="py-1 text-right font-mono tabular-nums">
                        {fmtDuration(project.seconds)} h
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </section>
        )}

        <section className="mt-6 border-t border-line pt-3 text-sm">
          <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
            <span className="text-ink-soft">Odpracováno celkem</span>
            <span className="font-medium">
              {fmtDuration(totalSeconds)} h (
              {totalHours.toLocaleString("cs-CZ", { maximumFractionDigits: 2 })} h)
            </span>
            {rate !== null && (
              <>
                <span className="text-ink-soft">
                  {unit === "hod" ? "Hodinová sazba" : "Měsíční sazba"}
                </span>
                <span>
                  {CZK.format(rate)}
                  {unit === "hod" ? " / hod" : " / měsíc"}
                </span>
                <span className="text-ink-soft">Odměna za období</span>
                <span className="font-semibold">{CZK.format(amount!)}</span>
              </>
            )}
          </div>
        </section>

        <section className="mt-16 grid grid-cols-2 gap-16 text-sm">
          {["Vypracoval(a)", "Schválil(a)"].map((label) => (
            <div key={label}>
              <div className="border-t border-ink pt-1 text-ink-soft">{label}</div>
              <div className="mt-8 border-t border-line pt-1 text-xs text-ink-soft/70">
                Datum a podpis
              </div>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
