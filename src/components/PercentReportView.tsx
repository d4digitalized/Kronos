"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";
import { entrySeconds } from "@/lib/format";
import { ProjectDot } from "@/components/ProjectPicker";
import type { Project, TimeEntry } from "@/lib/types";
import { ListSkeleton } from "@/components/Skeletons";

/** Délka pracovního dne, do které se procenta rozpadají. */
const DAY_HOURS = 8;
const DAY_SECONDS = DAY_HOURS * 3600;

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function mondayOf(d: Date): Date {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  x.setHours(0, 0, 0, 0);
  return x;
}

const DAY_LABEL = ["Po", "Út", "St", "Čt", "Pá", "So", "Ne"];

/** Denní výkaz v procentech (režim „Výkaz v %"): pruh dnů týdne nahoře,
    pod ním tabulka mých projektů. Napíšu procenta, potvrdím — a den se
    rozpadne do souvislých bloků time_entries od 8:00 (8h den). Uložení dne
    přepíše jeho dřívější výkaz (jiné záznamy tenhle režim vytvářet nemůže). */
export default function PercentReportView({
  wsId,
  userId,
}: {
  wsId: string;
  userId: string;
}) {
  const supabase = createClient();
  const [projects, setProjects] = useState<Project[]>([]);
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [day, setDay] = useState(() => isoDay(new Date()));
  const [inputs, setInputs] = useState<Record<string, string>>({});
  // popis činnosti k projektu — stane se popisem záznamu
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const weekEnd = useMemo(() => addDays(weekStart, 7), [weekStart]);

  const load = useCallback(async () => {
    const [projRes, entryRes] = await Promise.all([
      supabase
        .from("projects")
        .select("*")
        .eq("workspace_id", wsId)
        .eq("archived", false)
        .order("position")
        .order("name"),
      supabase
        .from("time_entries")
        .select("*")
        .eq("workspace_id", wsId)
        .eq("user_id", userId)
        .gte("started_at", weekStart.toISOString())
        .lt("started_at", weekEnd.toISOString()),
    ]);
    setProjects((projRes.data as Project[]) ?? []);
    setEntries((entryRes.data as TimeEntry[]) ?? []);
    setLoading(false);
  }, [supabase, wsId, userId, weekStart, weekEnd]);

  useEffect(() => {
    load();
  }, [load]);

  // procenta odpracovaná v jednotlivých dnech týdne (z uložených záznamů)
  const dayPct = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of entries) {
      if (!e.stopped_at) continue;
      const key = isoDay(new Date(e.started_at));
      map.set(
        key,
        (map.get(key) ?? 0) + entrySeconds(e.started_at, e.stopped_at)
      );
    }
    return new Map(
      [...map.entries()].map(([k, secs]) => [k, Math.round((secs / DAY_SECONDS) * 100)])
    );
  }, [entries]);

  // předvyplnění tabulky podle uloženého výkazu vybraného dne
  useEffect(() => {
    const byProject = new Map<string, number>();
    const noteByProject = new Map<string, string>();
    for (const e of entries) {
      if (!e.stopped_at || isoDay(new Date(e.started_at)) !== day) continue;
      const key = e.project_id ?? "";
      byProject.set(
        key,
        (byProject.get(key) ?? 0) + entrySeconds(e.started_at, e.stopped_at)
      );
      // dřívější generický popis „Denní výkaz X %" nepředvyplňovat
      if (e.description && !/^Denní výkaz \d+ %$/.test(e.description))
        noteByProject.set(key, e.description);
    }
    const next: Record<string, string> = {};
    for (const [projectId, secs] of byProject) {
      if (!projectId) continue;
      const pct = Math.round((secs / DAY_SECONDS) * 100);
      if (pct > 0) next[projectId] = String(pct);
    }
    setInputs(next);
    setNotes(Object.fromEntries(noteByProject));
  }, [day, entries]);

  const rows = projects.map((p) => {
    const pct = Math.max(0, Math.min(100, Number(inputs[p.id]) || 0));
    return { project: p, pct };
  });
  const total = rows.reduce((sum, r) => sum + r.pct, 0);

  async function save() {
    if (saving) return;
    if (total > 100) {
      toast("Součet nesmí přesáhnout 100 %.", "error");
      return;
    }
    setSaving(true);
    // den se přepisuje celý — jiné než výkazové záznamy v tomhle režimu nevznikají.
    // Nové bloky se nejdřív vloží a staré smažou až pak podle id: dřív se
    // den nejdřív smazal, a když pak vložení spadlo, výkaz dne zmizel.
    const dayStart = new Date(`${day}T00:00:00`);
    const { data: old, error: oldError } = await supabase
      .from("time_entries")
      .select("id")
      .eq("user_id", userId)
      .eq("workspace_id", wsId)
      .gte("started_at", dayStart.toISOString())
      .lt("started_at", addDays(dayStart, 1).toISOString());
    if (oldError) {
      setSaving(false);
      toast("Uložení výkazu se nezdařilo.", "error");
      return;
    }
    // souvislé bloky od 8:00 podle procent
    let cursor = new Date(`${day}T08:00:00`);
    const blocks = rows
      .filter((r) => r.pct > 0)
      .map((r) => {
        const secs = Math.round(DAY_SECONDS * (r.pct / 100));
        const started = cursor;
        const stopped = new Date(cursor.getTime() + secs * 1000);
        cursor = stopped;
        return {
          workspace_id: wsId,
          project_id: r.project.id,
          user_id: userId,
          // popis činnosti od uživatele; bez něj aspoň procento dne
          description:
            (notes[r.project.id] ?? "").trim() || `Denní výkaz ${r.pct} %`,
          started_at: started.toISOString(),
          stopped_at: stopped.toISOString(),
        };
      });
    if (blocks.length > 0) {
      const { error } = await supabase.from("time_entries").insert(blocks);
      if (error) {
        setSaving(false);
        toast("Uložení výkazu se nezdařilo.", "error");
        load();
        return;
      }
    }
    const oldIds = (old ?? []).map((r) => r.id as string);
    if (oldIds.length > 0) {
      const { error: delError } = await supabase
        .from("time_entries")
        .delete()
        .in("id", oldIds);
      if (delError) {
        setSaving(false);
        // nové bloky jsou uložené, staré zůstaly — další uložení je uklidí
        toast("Výkaz se uložil jen napůl — ulož ho prosím znovu.", "error");
        load();
        return;
      }
    }
    toast(
      blocks.length
        ? `Výkaz uložen: ${total} %.`
        : "Výkaz dne vymazán."
    );
    setSaving(false);
    load();
  }

  if (loading) return <ListSkeleton />;

  const today = isoDay(new Date());
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  return (
    <div className="w-full space-y-4">
      <div>
        <h1 className="font-display text-lg font-semibold">Denní výkaz</h1>
        <p className="text-xs text-ink-soft/70">
          Rozděl den procenty mezi projekty a potvrď — {DAY_HOURS}h den se uloží
          jako záznamy času.
        </p>
      </div>

      {/* pruh dnů: šipky přepínají týden, každý den ukazuje uložená % */}
      <div className="flex items-center gap-1.5 panel p-2">
        <button
          onClick={() => setWeekStart((w) => addDays(w, -7))}
          aria-label="Předchozí týden"
          className="rounded-md px-2 py-1 text-ink-soft hover:bg-black/5"
        >
          ‹
        </button>
        <div className="grid min-w-0 flex-1 grid-cols-7 gap-1">
          {days.map((d, i) => {
            const key = isoDay(d);
            const pct = dayPct.get(key) ?? 0;
            const selected = key === day;
            const future = key > today;
            return (
              <button
                key={key}
                onClick={() => setDay(key)}
                disabled={future}
                aria-pressed={selected}
                className={`flex flex-col items-center rounded-lg px-1 py-1.5 text-xs transition-colors disabled:opacity-30 ${
                  selected
                    ? "bg-accent text-white"
                    : "hover:bg-black/5"
                }`}
              >
                <span className={selected ? "" : "text-ink-soft/70"}>
                  {DAY_LABEL[i]} {d.getDate()}.
                </span>
                <span
                  className={`font-mono text-[11px] ${
                    selected
                      ? "text-white/80"
                      : pct >= 100
                        ? "text-accent"
                        : pct > 0
                          ? "text-brass"
                          : "text-ink-soft/40"
                  }`}
                >
                  {pct > 0 ? `${pct} %` : "—"}
                </span>
              </button>
            );
          })}
        </div>
        <button
          onClick={() => setWeekStart((w) => addDays(w, 7))}
          aria-label="Další týden"
          className="rounded-md px-2 py-1 text-ink-soft hover:bg-black/5"
        >
          ›
        </button>
      </div>

      {/* tabulka projektů s procenty */}
      {projects.length === 0 ? (
        <p className="panel p-6 text-sm text-ink-soft/70">
          Nejsi členem žádného projektu — požádej admina o přiřazení.
        </p>
      ) : (
        <div className="panel">
          <div className="divide-y divide-line/50">
            {rows.map(({ project }) => (
              <label
                key={project.id}
                className="flex cursor-pointer items-center gap-2.5 px-3 py-2"
              >
                <ProjectDot id={project.id} />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {project.name}
                </span>
                {/* popis činnosti — propíše se do záznamu místo „Denní výkaz X %" */}
                <input
                  type="text"
                  value={notes[project.id] ?? ""}
                  onChange={(e) =>
                    setNotes((prev) => ({ ...prev, [project.id]: e.target.value }))
                  }
                  placeholder="Popis aktivity"
                  aria-label={`Popis činnosti na ${project.name}`}
                  className="input-quiet min-w-40 flex-1 px-2 py-1 text-sm"
                />
                <span className="flex items-center gap-1">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={5}
                    inputMode="numeric"
                    value={inputs[project.id] ?? ""}
                    onChange={(e) =>
                      setInputs((prev) => ({
                        ...prev,
                        [project.id]: e.target.value,
                      }))
                    }
                    placeholder="0"
                    aria-label={`Procenta na ${project.name}`}
                    className="input w-20 px-2 py-1 text-right text-sm"
                  />
                  <span className="text-sm text-ink-soft/60">%</span>
                </span>
              </label>
            ))}
          </div>
          <div className="flex items-center justify-between border-t border-line/70 px-3 py-2.5">
            <span
              className={`text-sm ${
                total > 100 ? "font-medium text-danger" : "text-ink-soft"
              }`}
            >
              Celkem {total} %
              {total > 100 && " — přes 100 %"}
            </span>
            <button
              onClick={save}
              disabled={saving || total > 100}
              className="btn-primary disabled:opacity-60"
            >
              {saving ? "Ukládám…" : "Uložit výkaz"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
