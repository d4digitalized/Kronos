"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { entrySeconds } from "@/lib/format";
import {
  fetchRunningTimer,
  startSettled,
  startTimer,
  stopRunningTimer,
  updateRunningEntry,
  OPTIMISTIC_ID,
  TIMER_CHANGED_EVENT,
  type TimerChangedDetail,
} from "@/lib/timer";
import { toast } from "@/lib/toast";
import ProjectPicker, { ProjectDot } from "@/components/ProjectPicker";
import NotificationsBell from "@/components/NotificationsBell";
import FocusMode from "@/components/FocusMode";
import ElapsedClock from "@/components/ElapsedClock";
import type { Project, TimeEntry, Workspace } from "@/lib/types";

/** Rozdělaná focus seance: co měřit dál po pauze + sečtené dřívější úseky. */
type PausedFocus = {
  workspace_id: string;
  project_id: string | null;
  task_id: string | null;
  title: string;
  description: string;
  projectName: string | null;
  accum: number;
  /** uložený záznam pozastaveného úseku — popis dopsaný v pauze jde do něj */
  entryId: string | null;
};

/** Odlehčený úkol pro našeptávač v liště. */
type TaskLite = {
  id: string;
  title: string;
  project_id: string | null;
  projects: { name: string } | null;
};

type EntryPatch = { project_id?: string | null; description?: string };

// neověřený stav timeru zkoušet načíst znovu: 5 s, 15 s, 30 s, pak po minutě
const RETRY_MS = [5_000, 15_000, 30_000, 60_000];
// start a stop jsou jedno tlačítko na stejném místě — druhý klik dvojkliku
// by hned přepnul zpátky (stop → nový timer, start → minutový záznam)
const TOGGLE_GUARD_MS = 500;

export default function TimerBar({
  wsId,
  userId,
  workspaces = [],
  noTimer = false,
}: {
  wsId: string;
  userId: string;
  /** mé firmy — když timer běží v jiné firmě, lišta to řekne */
  workspaces?: Workspace[];
  /** výkaz v %: bez timeru — lišta nese jen zvoneček */
  noTimer?: boolean;
}) {
  const supabase = createClient();
  const [running, setRunning] = useState<TimeEntry | null>(null);
  // stav se nepodařilo ověřit (síť / přihlášení) — ukazujeme poslední známý
  const [syncProblem, setSyncProblem] = useState<"network" | "auth" | null>(null);
  const [retryN, setRetryN] = useState(0);
  const [projects, setProjects] = useState<Project[]>([]);
  const [description, setDescription] = useState("");
  const [idleProject, setIdleProject] = useState("");
  const [busy, setBusy] = useState(false);
  // našeptávač přiřazených úkolů
  const [myTasks, setMyTasks] = useState<TaskLite[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const suggestRef = useRef<HTMLDivElement>(null);
  // start/stop/pauza probíhá — jedna akce naráz. Ref (ne state), ať ho vidí
  // i listenery bez re-subscribe.
  const busyRef = useRef(false);
  // pořadí načítání: odpověď staršího load() nesmí přepsat novější stav
  // (načítání po focusu okna → klik na Stop → pozdní odpověď „běží")
  const loadSeq = useRef(0);
  const lastLoadAt = useRef(0);
  const authFails = useRef(0);
  const authToastShown = useRef(false);
  // během akce přišel podnět k přenačtení — provede se po ní
  const reloadAfterBusy = useRef(false);
  // Stop kliknutý během rozběhu startu nesmí propadnout — provede se po něm
  const stopQueued = useRef(false);
  const toggledAt = useRef(0);
  // změna projektu/popisu dřív, než server vrátí id nového záznamu
  const pendingPatch = useRef<EntryPatch | null>(null);
  const tasksLoadedAt = useRef(0);
  // focus mode (iPad): fullscreen s velkým časem, pauzou a stopem
  const [focusOpen, setFocusOpen] = useState(false);
  const [pausedFocus, setPausedFocus] = useState<PausedFocus | null>(null);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    lastLoadAt.current = Date.now();
    const res = await fetchRunningTimer(supabase, userId);
    if (seq !== loadSeq.current) return; // mezitím novější načtení nebo akce
    if (res.ok) {
      authFails.current = 0;
      setSyncProblem(null);
      setRetryN(0);
      setRunning(res.running);
      return;
    }
    // chyba ≠ „nic neběží": necháme poslední známý stav a zkusíme znovu
    setSyncProblem(res.auth ? "auth" : "network");
    setRetryN((n) => n + 1);
    authFails.current = res.auth ? authFails.current + 1 : 0;
    // jedno selhání může být jen souběh s obnovou tokenu — hlásit až opakované
    if (authFails.current >= 2 && !authToastShown.current) {
      authToastShown.current = true;
      toast("Přihlášení vypršelo — obnov prosím stránku (F5).", "error");
    }
  }, [supabase, userId]);

  // opakované načtení po chybě (každý neúspěch naplánuje další pokus)
  useEffect(() => {
    if (retryN === 0) return;
    const id = setTimeout(
      () => load(),
      RETRY_MS[Math.min(retryN - 1, RETRY_MS.length - 1)]
    );
    return () => clearTimeout(id);
  }, [retryN, load]);

  useEffect(() => {
    if (noTimer) return;
    load();
    // Přenačíst při změně timeru jinde (karta, Můj čas) i při návratu na
    // stránku: focus (přepnutí okna), visibilitychange (tab), pageshow
    // (bfcache — mobilní Zpět), online (síť zase naskočila).
    const refresh = () => {
      // během vlastní akce počkat — její výsledek je čerstvější než reload
      if (busyRef.current) {
        reloadAfterBusy.current = true;
        return;
      }
      // focus a visibilitychange chodí při přepnutí tabu spolu
      if (Date.now() - lastLoadAt.current < 1000) return;
      load();
    };
    const onTimerChanged = (e: Event) => {
      const detail = (e as CustomEvent<TimerChangedDetail>).detail;
      if (detail && "running" in detail) {
        // stav přímo z právě proběhlé akce (start/stop) — bez dotazu
        loadSeq.current++;
        setSyncProblem(null);
        setRetryN(0);
        setRunning(detail.running ?? null);
        return;
      }
      if (busyRef.current) reloadAfterBusy.current = true;
      else load();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener(TIMER_CHANGED_EVENT, onTimerChanged);
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(TIMER_CHANGED_EVENT, onTimerChanged);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, noTimer]);

  useEffect(() => {
    if (noTimer) return;
    supabase
      .from("projects")
      .select("*")
      .eq("workspace_id", wsId)
      .eq("archived", false)
      .order("position")
      .order("name")
      .then(({ data, error }) => {
        if (!error) setProjects((data as Project[]) ?? []);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, noTimer]);

  // úkoly přiřazené přihlášenému uživateli — zdroj pro našeptávač
  const loadMyTasks = useCallback(async () => {
    tasksLoadedAt.current = Date.now();
    const { data, error } = await supabase
      .from("task_assignees")
      .select("tasks!inner(id, title, project_id, projects(name))")
      .eq("user_id", userId)
      .eq("tasks.workspace_id", wsId)
      .is("tasks.completed_at", null)
      .is("tasks.parent_id", null);
    if (error) return; // necháme poslední seznam
    const tasks = ((data ?? []) as unknown as { tasks: TaskLite }[])
      .map((r) => r.tasks)
      .sort((a, b) => a.title.localeCompare(b.title, "cs"));
    setMyTasks(tasks);
  }, [supabase, wsId, userId]);

  useEffect(() => {
    if (noTimer) return;
    loadMyTasks();
  }, [loadMyTasks, noTimer]);

  // zavření našeptávače kliknutím mimo
  useEffect(() => {
    if (!suggestOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!suggestRef.current?.contains(e.target as Node)) setSuggestOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [suggestOpen]);

  // popis editujeme lokálně, do DB se ukládá na blur/Enter a se zastavením
  const runningId = running?.id;
  useEffect(() => {
    setDescription(running?.description ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningId]);

  // timer spuštěný v jiné firmě: jen ukázat (projekty v pickeru jsou zdejší)
  const foreignWsName =
    running && running.workspace_id !== wsId
      ? (workspaces.find((w) => w.id === running.workspace_id)?.name ?? "jiná firma")
      : null;
  const readOnlyEntry = !!running && (!!running.task_id || !!foreignWsName);

  // --------------------------------------------------------------- akce

  /** Jedna akce naráz. Po ní zařazený Stop, jinak odložený reload. */
  async function exclusive(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await action();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
    if (stopQueued.current) {
      stopQueued.current = false;
      await exclusive(() => doStop(undefined, null));
    } else if (reloadAfterBusy.current) {
      reloadAfterBusy.current = false;
      load();
    }
  }

  /** dvojklik na přepínací tlačítko — druhý klik zahodit */
  function toggleGuard(): boolean {
    if (Date.now() - toggledAt.current < TOGGLE_GUARD_MS) return false;
    toggledAt.current = Date.now();
    return true;
  }

  async function flushPendingPatch(entry: TimeEntry | null) {
    const patch = pendingPatch.current;
    pendingPatch.current = null;
    if (patch && entry) await updateRunningEntry(supabase, entry.id, patch);
  }

  async function start() {
    if (running || busyRef.current || !toggleGuard()) return;
    const projectId = idleProject || null;
    const desc = description.trim();
    await exclusive(async () => {
      const res = await startTimer(supabase, userId, {
        workspace_id: wsId,
        project_id: projectId,
        project_name: projects.find((p) => p.id === projectId)?.name ?? null,
        description: desc,
      });
      if (res.ok) setIdleProject("");
      await flushPendingPatch(res.running);
    });
  }

  // spustí timer rovnou na vybraném přiřazeném úkolu
  async function pickTask(task: TaskLite) {
    setSuggestOpen(false);
    setHighlight(-1);
    if (busyRef.current) return;
    setDescription("");
    await exclusive(async () => {
      const res = await startTimer(supabase, userId, {
        workspace_id: wsId,
        project_id: task.project_id,
        task_id: task.id,
        task_title: task.title,
        project_name: task.projects?.name ?? null,
      });
      if (res.ok) setIdleProject("");
      await flushPendingPatch(res.running);
    });
  }

  async function doStop(desc: string | undefined, prev: TimeEntry | null) {
    await startSettled(); // ▶ na kartě ještě dobíhá — zastavit až NOVÝ záznam
    loadSeq.current++; // rozjeté načítání by po odpovědi vrátilo „běží"
    setRunning(null); // optimisticky
    setPausedFocus(null); // stop ukončuje i rozdělanou focus seanci
    pendingPatch.current = null;
    const res = await stopRunningTimer(supabase, userId, { description: desc });
    if (!res.ok && prev) setRunning(prev); // vrátit; přesný stav dotáhne reload
  }

  /** Stop z lišty i z focus módu. `note` = text z focus módu; jinak se bere
      nedopsaný popis z pole v liště (klepnutí na tlačítko na iPadu pole
      nemusí opustit, takže by blur s uložením nepřišel). */
  function stop(note?: string, fromToggle = false) {
    if (!running) return;
    // druhý klik dvojkliku na ▶ — přistál by na ■ na stejném místě
    if (fromToggle && !toggleGuard()) return;
    if (busyRef.current) {
      stopQueued.current = true;
      return;
    }
    const current = (running.description ?? "").trim();
    const typed = note !== undefined ? note.trim() : description.trim();
    const editable = note !== undefined || (!running.task_id && !foreignWsName);
    const desc = editable && typed !== current ? typed : undefined;
    const prev = running.id === OPTIMISTIC_ID ? null : running;
    void exclusive(() => doStop(desc, prev));
  }

  async function saveRunningDescription(value: string) {
    if (!running || value === (running.description ?? "").trim()) return;
    setRunning({ ...running, description: value });
    if (!running.task_id) setDescription(value); // ať sedí i pole v liště
    if (running.id === OPTIMISTIC_ID) {
      pendingPatch.current = { ...pendingPatch.current, description: value };
      return;
    }
    await updateRunningEntry(supabase, running.id, { description: value });
  }

  function saveDescription() {
    void saveRunningDescription(description.trim());
  }

  function changeProject(projectId: string | null) {
    if (!running) {
      setIdleProject(projectId ?? "");
      return;
    }
    const name = projects.find((p) => p.id === projectId)?.name;
    setRunning({ ...running, project_id: projectId, projects: name ? { name } : null });
    if (running.id === OPTIMISTIC_ID) {
      pendingPatch.current = { ...pendingPatch.current, project_id: projectId };
      return;
    }
    void updateRunningEntry(supabase, running.id, { project_id: projectId });
  }

  // ------------------------------------------------------------ focus mode
  // Pauza = zastavit a uložit běžící záznam (přestávka se nepočítá do práce);
  // Pokračovat = nový záznam se stejným úkolem/projektem. Velký čas ve focus
  // módu sčítá úseky celé seance.

  function openFocus() {
    setPausedFocus(null); // nová seance, sčítání od nuly
    setFocusOpen(true);
  }

  async function pauseFocus(note: string) {
    if (!running || busyRef.current || !toggleGuard()) return;
    const prev = running;
    const before = pausedFocus;
    const value = note.trim();
    await exclusive(async () => {
      await startSettled();
      loadSeq.current++;
      setRunning(null);
      setPausedFocus({
        workspace_id: prev.workspace_id,
        project_id: prev.project_id ?? null,
        task_id: prev.task_id ?? null,
        title: prev.tasks?.title ?? "",
        description: value,
        projectName: prev.projects?.name ?? null,
        accum: (before?.accum ?? 0) + entrySeconds(prev.started_at, null),
        entryId: null,
      });
      const res = await stopRunningTimer(supabase, userId, {
        silent: true,
        description: value !== (prev.description ?? "").trim() ? value : undefined,
      });
      if (!res.ok) {
        setPausedFocus(before);
        setRunning(prev);
        return;
      }
      const stopped = res.stopped;
      if (stopped?.stopped_at) {
        // přesná délka úseku podle serveru
        const segment = entrySeconds(stopped.started_at, stopped.stopped_at);
        setPausedFocus((p) =>
          p && { ...p, entryId: stopped.id, accum: (before?.accum ?? 0) + segment }
        );
      }
    });
  }

  async function resumeFrom(p: PausedFocus) {
    await exclusive(async () => {
      const res = await startTimer(supabase, userId, {
        workspace_id: p.workspace_id,
        project_id: p.project_id,
        task_id: p.task_id,
        task_title: p.title || undefined,
        project_name: p.projectName,
        description: p.description,
      });
      await flushPendingPatch(res.running);
    });
  }

  function resumeFocus() {
    if (!pausedFocus || running || busyRef.current || !toggleGuard()) return;
    void resumeFrom(pausedFocus);
  }

  function stopFocus(note: string) {
    setFocusOpen(false);
    const p = pausedFocus;
    if (running) {
      stop(note);
      return;
    }
    setPausedFocus(null);
    // v pauze je záznam už uložený — jen do něj propsat dopsaný popis
    const value = note.trim();
    if (p?.entryId && value !== p.description)
      void updateRunningEntry(supabase, p.entryId, { description: value });
  }

  function closeFocus(note: string) {
    // zavření ✕ nikdy nenechá timer vypnutý: běžící běží dál, pauza se
    // před zavřením zase rozběhne (končí jen sčítání seance ve velkém čase)
    setFocusOpen(false);
    const p = pausedFocus;
    setPausedFocus(null);
    const value = note.trim();
    if (running) void saveRunningDescription(value);
    else if (p && !busyRef.current) void resumeFrom({ ...p, description: value });
  }

  /** Popis dopsaný ve focus módu (blur/Enter) — do běžícího záznamu, v pauze
      do uloženého úseku a do meta pro pokračování. */
  async function saveFocusDescription(text: string) {
    const value = text.trim();
    if (running) {
      if (pausedFocus) setPausedFocus({ ...pausedFocus, description: value });
      await saveRunningDescription(value);
    } else if (pausedFocus && value !== pausedFocus.description) {
      setPausedFocus({ ...pausedFocus, description: value });
      if (pausedFocus.entryId)
        await updateRunningEntry(supabase, pausedFocus.entryId, { description: value });
    }
  }

  if (noTimer) {
    return (
      <header className="sticky top-0 z-40 border-b border-line bg-surface/90 backdrop-blur">
        <div className="flex items-center justify-end gap-2 px-3 py-2.5 sm:px-4">
          <span className="min-w-0 flex-1 truncate text-sm text-ink-soft/70">
            Denní výkaz v %
          </span>
          <NotificationsBell wsId={wsId} userId={userId} />
        </div>
      </header>
    );
  }

  const q = description.trim().toLowerCase();
  const suggestions = (
    q ? myTasks.filter((t) => t.title.toLowerCase().includes(q)) : myTasks
  ).slice(0, 8);
  const showSuggest = suggestOpen && suggestions.length > 0;

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface/90 backdrop-blur">
      {/* jeden řádek i na mobilu — zalomení řešíme zmenšením popisu, ne wrapem */}
      <div className="flex items-center gap-2 px-3 py-2.5 sm:gap-3 sm:px-4">
        {readOnlyEntry && running ? (
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {running.tasks?.title || running.description || "Měřím čas"}
            </p>
            <p className="truncate text-xs text-ink-soft">
              {[running.projects?.name, foreignWsName && `běží ve firmě ${foreignWsName}`]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        ) : (
          <>
            <div ref={suggestRef} className="relative -ml-2 min-w-0 flex-1 sm:min-w-40">
              <input
                type="text"
                placeholder="Na čem děláš?"
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  setSuggestOpen(true);
                  setHighlight(-1);
                }}
                onFocus={() => {
                  setSuggestOpen(true);
                  // seznam přiřazených úkolů obnovit nejvýš jednou za 30 s
                  if (Date.now() - tasksLoadedAt.current > 30_000) loadMyTasks();
                }}
                onBlur={running ? saveDescription : undefined}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" && suggestions.length) {
                    e.preventDefault();
                    setSuggestOpen(true);
                    setHighlight((h) => Math.min(h + 1, suggestions.length - 1));
                    return;
                  }
                  if (e.key === "ArrowUp" && showSuggest) {
                    e.preventDefault();
                    setHighlight((h) => Math.max(h - 1, 0));
                    return;
                  }
                  if (e.key === "Escape" && showSuggest) {
                    setSuggestOpen(false);
                    setHighlight(-1);
                    return;
                  }
                  if (e.key !== "Enter") return;
                  if (showSuggest && highlight >= 0) {
                    e.preventDefault();
                    pickTask(suggestions[highlight]);
                    return;
                  }
                  if (running) e.currentTarget.blur();
                  else start();
                }}
                className="input-quiet w-full px-2 py-1.5 text-base"
              />
              {showSuggest && (
                <ul className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-xl">
                  {suggestions.map((t, i) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => pickTask(t)}
                        onMouseEnter={() => setHighlight(i)}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                          i === highlight ? "bg-accent-soft/60" : "hover:bg-black/[.03]"
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate">{t.title}</span>
                        <span className="flex shrink-0 items-center gap-1 text-xs text-ink-soft/70">
                          <ProjectDot id={t.project_id} className="h-2 w-2" />
                          {t.projects?.name ?? "—"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="shrink-0">
              <ProjectPicker
                projects={projects}
                value={running ? running.project_id : idleProject || null}
                onChange={changeProject}
                hideLabelOnMobile
              />
            </div>
          </>
        )}

        <span
          className={`shrink-0 font-mono text-base font-semibold tabular-nums sm:text-lg ${
            running ? "text-brass" : "text-ink-soft/50"
          }`}
        >
          <ElapsedClock startedAt={running?.started_at ?? null} />
        </span>

        {/* stav timeru se nepodařilo ověřit — ukazujeme poslední známý */}
        {syncProblem && (
          <span
            role="status"
            title={
              syncProblem === "auth"
                ? "Přihlášení vypršelo — obnov stránku (F5)."
                : "Stav timeru se nepodařilo ověřit (síť). Zkouším to znovu…"
            }
            aria-label="Stav timeru neověřen"
            className="h-2 w-2 shrink-0 rounded-full bg-amber-500"
          />
        )}

        {/* focus mode — fullscreen s velkým časem (iPad na stole) */}
        {running && (
          <button
            onClick={openFocus}
            aria-label="Focus mode přes celou obrazovku"
            title="Focus mode — velký čas přes celou obrazovku"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink-soft/70 hover:bg-black/5 hover:text-ink"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
              aria-hidden
            >
              <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
            </svg>
          </button>
        )}

        {running ? (
          // bez disabled: Stop během rozběhu startu se zařadí, nepropadne
          <button
            onClick={() => stop(undefined, true)}
            aria-busy={busy}
            aria-label="Zastavit timer a uložit záznam"
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-600 text-white shadow-sm hover:bg-red-500 ${
              busy ? "opacity-60" : ""
            }`}
          >
            <span className="block h-3.5 w-3.5 rounded-[2px] bg-current" />
          </button>
        ) : (
          <button
            onClick={start}
            disabled={busy}
            aria-label="Spustit timer"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-white shadow-sm hover:bg-[#0a5d54] disabled:opacity-60"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="ml-0.5 h-4 w-4" aria-hidden>
              <path d="M7 4.5v15l13-7.5z" />
            </svg>
          </button>
        )}

        <NotificationsBell wsId={wsId} userId={userId} />
      </div>

      {focusOpen && (running || pausedFocus) && (
        <FocusMode
          running={running}
          accumSeconds={pausedFocus?.accum ?? 0}
          taskTitle={
            running ? (running.tasks?.title ?? null) : pausedFocus?.title || null
          }
          description={
            running
              ? (running.description ?? "")
              : (pausedFocus?.description ?? "")
          }
          projectName={
            running
              ? (running.projects?.name ?? null)
              : (pausedFocus?.projectName ?? null)
          }
          busy={busy}
          onPause={pauseFocus}
          onResume={resumeFocus}
          onStop={stopFocus}
          onClose={closeFocus}
          onSaveDescription={saveFocusDescription}
        />
      )}
    </header>
  );
}
