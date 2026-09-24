"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { cacheGet, cacheSet } from "@/lib/viewCache";
import { dayKey, entrySeconds, fmtDuration, fmtTime } from "@/lib/format";
import { toast } from "@/lib/toast";
import {
  notifyTimerChanged,
  OPTIMISTIC_ID,
  TIMER_CHANGED_EVENT,
  type TimerChangedDetail,
} from "@/lib/timer";
import { confirmDialog } from "@/lib/confirm";
import Picker from "@/components/Picker";
import ProjectPicker, { ProjectDot } from "@/components/ProjectPicker";
import type { Project, Task, TimeEntry } from "@/lib/types";
import { ListSkeleton } from "@/components/Skeletons";

const CARD_ICON = "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM7 9h10M7 13h6";

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function MyTimeView({
  wsId,
  userId,
}: {
  wsId: string;
  userId: string;
}) {
  const supabase = createClient();
  const cacheKey = `mytime:${wsId}:${userId}`;
  const cached = cacheGet<{ entries: TimeEntry[]; projects: Project[] }>(cacheKey);
  const [entries, setEntries] = useState<TimeEntry[]>(cached?.entries ?? []);
  const [projects, setProjects] = useState<Project[]>(cached?.projects ?? []);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(!cached);
  const [loadError, setLoadError] = useState(false);
  // pořadí načítání: starší odpověď nesmí přepsat novější
  const loadSeq = useRef(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editStart, setEditStart] = useState("");
  const [editStop, setEditStop] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editProject, setEditProject] = useState<string | null>(null);

  // ruční zápis
  const [addProject, setAddProject] = useState("");
  const [addTask, setAddTask] = useState("");
  const [addDescription, setAddDescription] = useState("");
  // místní den (toISOString dává UTC — po půlnoci by nabídl včerejšek)
  const [addDate, setAddDate] = useState(() => dayKey(new Date().toISOString()));
  const [addFrom, setAddFrom] = useState("09:00");
  const [addTo, setAddTo] = useState("10:00");
  const [addError, setAddError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const [entriesRes, projectsRes] = await Promise.all([
      supabase
        .from("time_entries")
        .select("*, tasks(title), projects(name)")
        .eq("workspace_id", wsId)
        .eq("user_id", userId)
        .gte("started_at", since.toISOString())
        .order("started_at", { ascending: false }),
      supabase
        .from("projects")
        .select("*")
        .eq("workspace_id", wsId)
        .eq("archived", false)
        .order("position")
        .order("name"),
    ]);
    if (seq !== loadSeq.current) return;
    setLoading(false);
    // chyba ≠ „žádné záznamy": necháme, co je vidět, a nic necachujeme
    if (entriesRes.error || projectsRes.error) {
      setLoadError(true);
      return;
    }
    setLoadError(false);
    const nextEntries = (entriesRes.data as TimeEntry[]) ?? [];
    const nextProjects = (projectsRes.data as Project[]) ?? [];
    setEntries(nextEntries);
    setProjects(nextProjects);
    cacheSet(cacheKey, { entries: nextEntries, projects: nextProjects });
  }, [supabase, wsId, userId, cacheKey]);

  useEffect(() => {
    load();
    // zastavený / spuštěný timer v liště → hned vidět v seznamu
    const onTimerChanged = (e: Event) => {
      const detail = (e as CustomEvent<TimerChangedDetail>).detail;
      if (detail?.running?.id === OPTIMISTIC_ID) return; // záznam ještě není v DB
      load();
    };
    window.addEventListener(TIMER_CHANGED_EVENT, onTimerChanged);
    return () => window.removeEventListener(TIMER_CHANGED_EVENT, onTimerChanged);
  }, [load]);

  // karty pro vybraný projekt (volitelná vazba ručního zápisu)
  useEffect(() => {
    setAddTask("");
    if (!addProject) {
      setTasks([]);
      return;
    }
    supabase
      .from("tasks")
      .select("id, title")
      .eq("project_id", addProject)
      .is("completed_at", null)
      .order("created_at", { ascending: false })
      .then(({ data }) => setTasks((data as unknown as Task[]) ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addProject]);

  async function addEntry(e: React.FormEvent) {
    e.preventDefault();
    setAddError(null);
    if (!addProject) {
      setAddError("Vyber projekt.");
      return;
    }
    const started = new Date(`${addDate}T${addFrom}`);
    const stopped = new Date(`${addDate}T${addTo}`);
    if (stopped <= started) {
      setAddError("Konec musí být po začátku.");
      return;
    }
    const { error } = await supabase.from("time_entries").insert({
      workspace_id: wsId,
      project_id: addProject,
      task_id: addTask || null,
      description: addDescription.trim(),
      user_id: userId,
      started_at: started.toISOString(),
      stopped_at: stopped.toISOString(),
    });
    if (error) {
      setAddError("Uložení se nezdařilo.");
      return;
    }
    setAddDescription("");
    load();
  }

  function startEdit(entry: TimeEntry) {
    setEditingId(entry.id);
    setEditStart(toLocalInput(entry.started_at));
    setEditStop(entry.stopped_at ? toLocalInput(entry.stopped_at) : "");
    setEditDesc(entry.description ?? "");
    setEditProject(entry.project_id ?? null);
  }

  async function saveEdit(entry: TimeEntry) {
    const started = new Date(editStart);
    const stopped = editStop ? new Date(editStop) : null;
    if (stopped && stopped <= started) {
      toast("Konec záznamu musí být po začátku.", "error");
      return;
    }
    const patch: Record<string, unknown> = {
      started_at: started.toISOString(),
      stopped_at: stopped ? stopped.toISOString() : entry.stopped_at,
      description: editDesc.trim(),
    };
    // přeřazení do jiného projektu odpojí kartu (patří k původnímu projektu)
    if ((entry.project_id ?? null) !== editProject) {
      patch.project_id = editProject;
      patch.task_id = null;
    }
    const { error } = await supabase
      .from("time_entries")
      .update(patch)
      .eq("id", entry.id);
    if (error) {
      toast("Uložení záznamu se nezdařilo.", "error");
      return;
    }
    setEditingId(null);
    notifyTimerChanged(); // přenačte seznam i lištu (mohl to být běžící záznam)
  }

  async function remove(entry: TimeEntry) {
    const ok = await confirmDialog({
      title: "Smazat záznam?",
      message: "Tento záznam času se nenávratně smaže.",
    });
    if (!ok) return;
    const { error } = await supabase.from("time_entries").delete().eq("id", entry.id);
    if (error) {
      toast("Záznam se nepodařilo smazat.", "error");
      return;
    }
    notifyTimerChanged(); // přenačte seznam i lištu (mohl to být běžící záznam)
  }

  if (loading) return <ListSkeleton />;

  const byDay = new Map<string, TimeEntry[]>();
  for (const entry of entries) {
    const key = dayKey(entry.started_at);
    byDay.set(key, [...(byDay.get(key) ?? []), entry]);
  }

  return (
    <div className="space-y-4">
      <form
        onSubmit={addEntry}
        className="flex flex-wrap items-center gap-x-1 gap-y-2 panel py-2 pl-4 pr-2"
      >
        <input
          type="text"
          placeholder="Popis (volitelné)"
          value={addDescription}
          onChange={(e) => setAddDescription(e.target.value)}
          className="input-quiet -ml-2 min-w-40 flex-1 px-2 py-1.5 text-sm"
        />
        <span className="mx-1 hidden h-6 w-px bg-line sm:block" aria-hidden />
        <ProjectPicker
          projects={projects}
          value={addProject || null}
          onChange={(id) => setAddProject(id ?? "")}
          align="left"
        />
        <Picker
          options={[
            { id: null, label: "Bez karty" },
            ...tasks.map((t) => ({ id: t.id as string | null, label: t.title })),
          ]}
          value={addTask || null}
          onChange={(id) => setAddTask(id ?? "")}
          placeholder="Karta"
          iconPath={CARD_ICON}
          ariaLabel="Karta"
          align="left"
          disabled={!addProject}
        />
        <span className="mx-1 hidden h-6 w-px bg-line sm:block" aria-hidden />
        <input
          type="date"
          required
          value={addDate}
          onChange={(e) => setAddDate(e.target.value)}
          aria-label="Datum"
          className="rounded-lg bg-transparent px-2 py-1.5 text-sm text-ink-soft hover:bg-black/5"
        />
        <input
          type="time"
          required
          value={addFrom}
          onChange={(e) => setAddFrom(e.target.value)}
          aria-label="Začátek"
          className="rounded-lg bg-transparent px-2 py-1.5 text-sm text-ink-soft hover:bg-black/5"
        />
        <span className="text-ink-soft/50">–</span>
        <input
          type="time"
          required
          value={addTo}
          onChange={(e) => setAddTo(e.target.value)}
          aria-label="Konec"
          className="rounded-lg bg-transparent px-2 py-1.5 text-sm text-ink-soft hover:bg-black/5"
        />
        <button type="submit" className="btn-primary ml-2">
          Zapsat čas
        </button>
        {addError && <p className="w-full text-sm text-danger">{addError}</p>}
      </form>

      {loadError && (
        <p className="flex flex-wrap items-center gap-2 p-4 text-sm text-danger">
          Záznamy se nepodařilo načíst.
          <button onClick={load} className="rounded-md px-2 py-1 text-xs underline">
            Zkusit znovu
          </button>
        </p>
      )}

      {entries.length === 0 && !loadError && (
        <p className="p-4 text-sm text-ink-soft/70">
          Za posledních 30 dní tu nejsou žádné záznamy.
        </p>
      )}

      {[...byDay.entries()].map(([day, dayEntries]) => {
        const total = dayEntries.reduce(
          (sum, e) => sum + (e.stopped_at ? entrySeconds(e.started_at, e.stopped_at) : 0),
          0
        );
        return (
          <div key={day} className="panel">
            <div className="flex items-center justify-between border-b border-line/70 px-3 py-2">
              <span className="text-sm font-medium">
                {new Date(`${day}T00:00`).toLocaleDateString("cs-CZ", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                })}
              </span>
              <span className="font-mono text-sm text-ink-soft">
                {fmtDuration(total)} h
              </span>
            </div>
            <div className="divide-y divide-line/50">
              {dayEntries.map((entry) => (
                <div key={entry.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  {editingId === entry.id ? (
                    <>
                      <input
                        type="text"
                        value={editDesc}
                        onChange={(e) => setEditDesc(e.target.value)}
                        placeholder="Popis…"
                        aria-label="Popis záznamu"
                        className="input min-w-36 flex-1 px-2 py-1 text-sm"
                      />
                      <ProjectPicker
                        projects={projects}
                        value={editProject}
                        onChange={setEditProject}
                        align="right"
                      />
                      <input
                        type="datetime-local"
                        value={editStart}
                        onChange={(e) => setEditStart(e.target.value)}
                        className="input px-1 py-0.5 text-xs"
                      />
                      {entry.stopped_at && (
                        <input
                          type="datetime-local"
                          value={editStop}
                          onChange={(e) => setEditStop(e.target.value)}
                          className="input px-1 py-0.5 text-xs"
                        />
                      )}
                      <button
                        onClick={() => saveEdit(entry)}
                        className="btn-primary px-2 py-1 text-xs"
                      >
                        Uložit
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="rounded-md px-2 py-1 text-xs text-ink-soft"
                      >
                        Zrušit
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">
                          {entry.tasks?.title || entry.description || "(bez popisu)"}
                        </p>
                        <p className="flex items-center gap-1.5 text-xs text-ink-soft/70">
                          <ProjectDot
                            id={entry.project_id ?? null}
                            className="h-2 w-2"
                          />
                          <span className="truncate">
                            {entry.projects?.name ?? "Bez projektu"}
                          </span>
                        </p>
                      </div>
                      <span className="text-xs text-ink-soft">
                        {fmtTime(entry.started_at)}
                        {" – "}
                        {entry.stopped_at ? fmtTime(entry.stopped_at) : "běží"}
                      </span>
                      <span className="font-mono text-sm tabular-nums">
                        {entry.stopped_at
                          ? fmtDuration(entrySeconds(entry.started_at, entry.stopped_at))
                          : "•"}
                      </span>
                      <button
                        onClick={() => startEdit(entry)}
                        className="rounded-md px-2 py-1 text-xs text-ink-soft hover:bg-black/5"
                      >
                        Upravit
                      </button>
                      <button
                        onClick={() => remove(entry)}
                        className="rounded-md px-2 py-1 text-xs text-danger hover:bg-danger/10"
                      >
                        Smazat
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
