"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/fetchAll";
import { entrySeconds, fmtDate, fmtDuration, fmtTime } from "@/lib/format";
import { toast } from "@/lib/toast";
import ProjectPicker, { ProjectDot } from "@/components/ProjectPicker";
import Avatar from "@/components/Avatar";
import type { Project, TimeEntry } from "@/lib/types";

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function firstOfMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function today(): string {
  return isoDay(new Date());
}

const PRESETS: { label: string; range: () => [string, string] }[] = [
  {
    label: "Tento týden",
    range: () => {
      const now = new Date();
      const monday = new Date(now);
      monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
      return [isoDay(monday), isoDay(now)];
    },
  },
  { label: "Tento měsíc", range: () => [firstOfMonth(), today()] },
  {
    label: "Minulý měsíc",
    range: () => {
      const now = new Date();
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return [isoDay(first), isoDay(last)];
    },
  },
];

type Agg = {
  id: string | null;
  name: string;
  seconds: number;
  count: number;
  profile?: TimeEntry["profiles"];
};
type Detail = { kind: "person" | "project"; id: string | null; name: string };

function hm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Stejné datum, nový čas HH:MM (lokálně). */
function withTime(iso: string, time: string): string {
  const d = new Date(iso);
  const [h, m] = time.split(":").map(Number);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

export default function ReportsView({
  wsId,
  userId,
  isAdmin = true,
}: {
  wsId: string;
  userId?: string;
  isAdmin?: boolean;
}) {
  const supabase = createClient();
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [hrTargets, setHrTargets] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // rychlé přepínání období: starší odpověď nesmí přepsat novější
  const loadSeq = useRef(0);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [tab, setTab] = useState<"person" | "project">("person");
  const [rate, setRate] = useState("");
  const [rateUnit, setRateUnit] = useState<"mesic" | "hod">("mesic");

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    const toExclusive = new Date(`${to}T00:00`);
    toExclusive.setDate(toExclusive.getDate() + 1);
    // všechny stránky — jinak nad 1000 záznamů za období chybí náhodné záznamy
    const { data, error } = await fetchAllRows<TimeEntry>((a, b) =>
      supabase
        .from("time_entries")
        .select(
          "id, started_at, stopped_at, user_id, project_id, description, profiles(full_name, email, avatar_initials, avatar_color), projects(name), tasks(title)"
        )
        .eq("workspace_id", wsId)
        .not("stopped_at", "is", null)
        .gte("started_at", new Date(`${from}T00:00`).toISOString())
        .lt("started_at", toExclusive.toISOString())
        .order("started_at")
        .order("id")
        .range(a, b)
    );
    if (seq !== loadSeq.current) return;
    setLoading(false);
    // chyba ≠ „žádné hodiny": neukazovat nulové součty jako skutečnost
    setLoadError(!!error);
    if (!error) setEntries(data);
  }, [supabase, wsId, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    supabase
      .from("projects")
      .select("*")
      .eq("workspace_id", wsId)
      .eq("archived", false)
      .order("position")
      .order("name")
      .then(({ data }) => setProjects((data as Project[]) ?? []));
    // HR s grantem smí záznamy přidělených lidí i upravovat (0043);
    // právo hlídá RLS, tady jen zjišťujeme, komu zobrazit editační pole
    if (userId) {
      (async () => {
        const [{ data: me }, { data: grants }] = await Promise.all([
          supabase
            .from("workspace_members")
            .select("can_hr")
            .eq("workspace_id", wsId)
            .eq("user_id", userId)
            .maybeSingle(),
          supabase
            .from("hr_grants")
            .select("target_id")
            .eq("workspace_id", wsId)
            .eq("user_id", userId),
        ]);
        setHrTargets(
          me?.can_hr
            ? new Set((grants ?? []).map((g) => g.target_id as string))
            : new Set()
        );
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, userId]);

  /** Smí přihlášený tenhle záznam upravovat? (vlastní / admin / HR grant) */
  function canEdit(entry: TimeEntry): boolean {
    return (
      isAdmin || entry.user_id === userId || hrTargets.has(entry.user_id)
    );
  }

  /** Uloží dílčí úpravu záznamu (popis, časy) a promítne ji lokálně. */
  async function saveEntry(
    entry: TimeEntry,
    patch: Partial<Pick<TimeEntry, "description" | "started_at" | "stopped_at">>
  ) {
    const { error } = await supabase
      .from("time_entries")
      .update(patch)
      .eq("id", entry.id);
    if (error) {
      toast("Úpravu se nepodařilo uložit.", "error");
      return;
    }
    setEntries((prev) =>
      prev.map((e) => (e.id === entry.id ? { ...e, ...patch } : e))
    );
    toast("Záznam upraven.");
  }

  function saveTime(entry: TimeEntry, which: "started_at" | "stopped_at", time: string) {
    if (!time) return;
    const iso = withTime(entry[which]!, time);
    const started = which === "started_at" ? iso : entry.started_at;
    const stopped = which === "stopped_at" ? iso : entry.stopped_at;
    if (stopped && started >= stopped) {
      toast("Konec musí být po začátku.", "error");
      return;
    }
    saveEntry(entry, { [which]: iso });
  }

  /** Přeřazení záznamu do jiného projektu; karta z původního projektu se odpojí. */
  async function reassign(entry: TimeEntry, projectId: string | null) {
    if ((entry.project_id ?? null) === projectId) return;
    const { error } = await supabase
      .from("time_entries")
      .update({ project_id: projectId, task_id: null })
      .eq("id", entry.id);
    if (error) {
      toast("Přeřazení záznamu se nezdařilo.", "error");
      return;
    }
    const projectName = projects.find((p) => p.id === projectId)?.name ?? null;
    setEntries((prev) =>
      prev.map((e) =>
        e.id === entry.id
          ? {
              ...e,
              project_id: projectId,
              projects: projectName ? { name: projectName } : null,
              task_id: null,
              tasks: null,
            }
          : e
      )
    );
    toast(`Záznam přeřazen: ${projectName ?? "Bez projektu"}.`);
  }

  const byPerson = new Map<string, Agg>();
  const byProject = new Map<string, Agg>();
  let total = 0;
  for (const entry of entries) {
    const seconds = entrySeconds(entry.started_at, entry.stopped_at);
    total += seconds;
    const personName = entry.profiles?.full_name || entry.profiles?.email || "?";
    const person = byPerson.get(entry.user_id) ?? {
      id: entry.user_id,
      name: personName,
      seconds: 0,
      count: 0,
      profile: entry.profiles,
    };
    person.seconds += seconds;
    person.count += 1;
    byPerson.set(entry.user_id, person);

    const projectKey = entry.project_id ?? "";
    const project = byProject.get(projectKey) ?? {
      id: entry.project_id ?? null,
      name: entry.projects?.name ?? "Bez projektu",
      seconds: 0,
      count: 0,
    };
    project.seconds += seconds;
    project.count += 1;
    byProject.set(projectKey, project);
  }
  // lidé podle odpracovaného času; projekty podle pořadí nastaveného adminem
  // (archivované za nimi, „Bez projektu" poslední)
  const projectPos = new Map(projects.map((p) => [p.id, p.position]));
  const sortedPeople = [...byPerson.values()].sort((a, b) => b.seconds - a.seconds);
  const sortedProjects = [...byProject.values()].sort((a, b) => {
    const pa = a.id === null ? Infinity : projectPos.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const pb = b.id === null ? Infinity : projectPos.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return pa - pb || b.seconds - a.seconds;
  });

  const detailEntries = detail
    ? entries
        .filter((e) =>
          detail.kind === "person"
            ? e.user_id === detail.id
            : (e.project_id ?? null) === detail.id
        )
        .sort((a, b) => a.started_at.localeCompare(b.started_at))
    : [];
  const detailTotal = detailEntries.reduce(
    (sum, e) => sum + entrySeconds(e.started_at, e.stopped_at),
    0
  );

  function toggleDetail(kind: Detail["kind"], row: Agg) {
    setDetail((current) =>
      current && current.kind === kind && current.id === row.id
        ? null
        : { kind, id: row.id, name: row.name }
    );
  }

  function vykazUrl(): string {
    const params = new URLSearchParams({ ws: wsId, user: detail!.id!, from, to });
    // Sazbu do výkazu vkládá jen admin; běžný uživatel exportuje pouze hodiny.
    const parsed = Number(rate.replace(",", "."));
    if (isAdmin && rate.trim() && Number.isFinite(parsed) && parsed > 0) {
      params.set("rate", String(parsed));
      params.set("unit", rateUnit);
    }
    return `/vykaz?${params.toString()}`;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 panel p-3">
        <span className="text-sm font-medium">Období</span>
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="input px-2 py-1"
        />
        <span className="text-ink-soft/70">–</span>
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="input px-2 py-1"
        />
        <span className="hidden text-ink-soft/40 sm:inline">·</span>
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            onClick={() => {
              const [f, t] = preset.range();
              setFrom(f);
              setTo(t);
            }}
            className="rounded-md bg-black/5 px-2 py-1 text-xs text-ink-soft hover:bg-accent-soft hover:text-accent"
          >
            {preset.label}
          </button>
        ))}
        <span className="ml-auto text-sm text-ink-soft">
          Celkem <span className="font-mono font-medium">{fmtDuration(total)} h</span>
        </span>
      </div>

      {loading ? (
        <p className="p-4 text-ink-soft/70">Načítám…</p>
      ) : loadError ? (
        <p className="flex flex-wrap items-center gap-2 p-4 text-sm text-danger">
          Záznamy se nepodařilo načíst.
          <button onClick={load} className="rounded-md px-2 py-1 text-xs underline">
            Zkusit znovu
          </button>
        </p>
      ) : (
        <div className="panel">
          <div className="flex items-center gap-2 border-b border-line/70 px-3 py-2">
            <div className="inline-flex rounded-lg bg-black/5 p-0.5 text-sm">
              {(
                [
                  ["person", "Po lidech", sortedPeople.length],
                  ["project", "Po projektech", sortedProjects.length],
                ] as const
              ).map(([key, label, count]) => (
                <button
                  key={key}
                  onClick={() => {
                    setTab(key);
                    setDetail(null);
                  }}
                  aria-pressed={tab === key}
                  className={`rounded-md px-3 py-1 transition-colors ${
                    tab === key
                      ? "bg-surface font-medium text-ink shadow-sm"
                      : "text-ink-soft hover:text-ink"
                  }`}
                >
                  {label}
                  <span className="ml-1.5 text-xs text-ink-soft/60">{count}</span>
                </button>
              ))}
            </div>
          </div>
          {(
            [
              tab === "person"
                ? (["person", sortedPeople] as const)
                : (["project", sortedProjects] as const),
            ] as const
          ).map(([kind, rows]) => (
            <div key={kind}>
              {rows.length === 0 ? (
                <p className="p-3 text-sm text-ink-soft/70">Žádná data za období.</p>
              ) : (
                <div className="divide-y divide-line/50">
                  {rows.map((row) => {
                    const selected =
                      detail?.kind === kind && detail.id === row.id;
                    return (
                      <button
                        key={row.id ?? "none"}
                        onClick={() => toggleDetail(kind, row)}
                        aria-expanded={selected}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                          selected
                            ? "bg-accent-soft text-accent"
                            : "hover:bg-black/[.03]"
                        }`}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          className={`h-3.5 w-3.5 shrink-0 transition-transform ${
                            selected ? "rotate-90 text-accent" : "text-ink-soft/50"
                          }`}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden
                        >
                          <path d="m9 6 6 6-6 6" />
                        </svg>
                        {kind === "project" ? (
                          <ProjectDot id={row.id} />
                        ) : (
                          <Avatar
                            profile={row.profile}
                            colorKey={row.id ?? "?"}
                            size="sm"
                          />
                        )}
                        <span className="min-w-0 flex-1 truncate">{row.name}</span>
                        <span className="text-xs text-ink-soft/60">
                          {row.count}×
                        </span>
                        <span className="font-mono tabular-nums">
                          {fmtDuration(row.seconds)} h
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {!loading && detail && (
        <div className="panel">
          <div className="flex flex-wrap items-center gap-2 border-b border-line/70 px-3 py-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              {detail.kind === "project" ? (
                <ProjectDot id={detail.id} />
              ) : (
                <Avatar
                  profile={detailEntries[0]?.profiles}
                  colorKey={detail.id ?? "?"}
                  size="sm"
                />
              )}
              <span>
                {detail.kind === "person" ? "Záznamy — " : "Záznamy projektu — "}
                {detail.name}
              </span>
            </h2>
            <span className="text-xs text-ink-soft/70">
              {detailEntries.length} záznamů ·{" "}
              <span className="font-mono">{fmtDuration(detailTotal)} h</span>
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {detail.kind === "person" && (
                <>
                  {isAdmin && (
                    <>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={rate}
                        onChange={(e) => setRate(e.target.value)}
                        placeholder="Sazba (Kč)"
                        aria-label="Sazba v Kč (volitelné)"
                        className="input w-28 px-2 py-1 text-sm"
                      />
                      <select
                        value={rateUnit}
                        onChange={(e) =>
                          setRateUnit(e.target.value as "mesic" | "hod")
                        }
                        aria-label="Typ sazby"
                        className="input px-2 py-1 text-sm"
                      >
                        <option value="mesic">Kč / měsíc</option>
                        <option value="hod">Kč / hod</option>
                      </select>
                    </>
                  )}
                  <a
                    href={vykazUrl()}
                    target="_blank"
                    rel="noopener"
                    className="btn-primary"
                  >
                    Export PDF
                  </a>
                </>
              )}
              <button
                onClick={() => setDetail(null)}
                className="btn-ghost px-2 py-1 text-xs"
              >
                Zavřít
              </button>
            </div>
          </div>
          {detailEntries.length === 0 ? (
            <p className="p-3 text-sm text-ink-soft/70">Žádné záznamy za období.</p>
          ) : (
            <div className="-mx-px overflow-x-auto scroll-touch">
            <table className="w-full min-w-[32rem] text-sm">
              <thead>
                <tr className="border-b border-line/70 text-left text-xs text-ink-soft">
                  <th className="px-3 py-2 font-medium">Datum</th>
                  <th className="px-3 py-2 font-medium">Popis</th>
                  {detail.kind === "project" && (
                    <th className="px-3 py-2 font-medium">Osoba</th>
                  )}
                  <th className="px-1 py-2 font-medium">Projekt</th>
                  <th className="hidden px-3 py-2 font-medium sm:table-cell">Čas</th>
                  <th className="px-3 py-2 text-right font-medium">Hodiny</th>
                </tr>
              </thead>
              <tbody>
                {detailEntries.map((entry) => {
                  const editable = canEdit(entry);
                  return (
                  <tr key={entry.id} className="border-b border-line/50 last:border-0">
                    <td className="whitespace-nowrap px-3 py-2 text-ink-soft">
                      {fmtDate(entry.started_at)}
                    </td>
                    <td className="max-w-64 px-3 py-1">
                      {editable ? (
                        <input
                          key={`${entry.id}-desc`}
                          type="text"
                          defaultValue={entry.description ?? ""}
                          placeholder={entry.tasks?.title || "Popis…"}
                          aria-label="Popis záznamu"
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (v !== (entry.description ?? ""))
                              saveEntry(entry, { description: v });
                          }}
                          className="input w-full min-w-36 truncate px-2 py-1 text-sm"
                        />
                      ) : (
                        <span className="block truncate py-1">
                          {entry.tasks?.title || entry.description || "—"}
                        </span>
                      )}
                    </td>
                    {detail.kind === "project" && (
                      <td className="px-3 py-2 text-ink-soft">
                        {entry.profiles?.full_name || entry.profiles?.email || "?"}
                      </td>
                    )}
                    <td className="px-1 py-1">
                      {editable ? (
                        <ProjectPicker
                          projects={projects}
                          value={entry.project_id}
                          onChange={(id) => reassign(entry, id)}
                          align="left"
                        />
                      ) : (
                        <span className="flex items-center gap-1.5 px-1 py-1 text-ink-soft">
                          <ProjectDot id={entry.project_id} />
                          <span className="truncate">
                            {entry.projects?.name ?? "Bez projektu"}
                          </span>
                        </span>
                      )}
                    </td>
                    <td className="hidden whitespace-nowrap px-3 py-1 text-ink-soft sm:table-cell">
                      {editable ? (
                        <span className="flex items-center gap-1">
                          <input
                            key={`${entry.id}-start`}
                            type="time"
                            defaultValue={hm(entry.started_at)}
                            aria-label="Začátek"
                            onBlur={(e) =>
                              e.target.value !== hm(entry.started_at) &&
                              saveTime(entry, "started_at", e.target.value)
                            }
                            className="input px-1.5 py-0.5 text-xs"
                          />
                          <span className="text-ink-soft/50">–</span>
                          <input
                            key={`${entry.id}-stop`}
                            type="time"
                            defaultValue={entry.stopped_at ? hm(entry.stopped_at) : ""}
                            aria-label="Konec"
                            onBlur={(e) =>
                              entry.stopped_at &&
                              e.target.value !== hm(entry.stopped_at) &&
                              saveTime(entry, "stopped_at", e.target.value)
                            }
                            className="input px-1.5 py-0.5 text-xs"
                          />
                        </span>
                      ) : (
                        <>
                          {fmtTime(entry.started_at)} –{" "}
                          {entry.stopped_at ? fmtTime(entry.stopped_at) : ""}
                        </>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {fmtDuration(entrySeconds(entry.started_at, entry.stopped_at))}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          )}
        </div>
      )}

      <p className="text-xs text-ink-soft/70">
        Běžící (nezastavené) timery se do přehledu nepočítají.
      </p>
    </div>
  );
}
