"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cacheGet, cacheSet } from "@/lib/viewCache";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { createClient } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";
import { fmtClock } from "@/lib/format";
import { syncTaskCalendar } from "@/app/actions/calendar";
import { ProjectDot, projectColor } from "@/components/ProjectPicker";
import LoadError from "@/components/LoadError";
import type { Membership, Task } from "@/lib/types";
import { MyDaySkeleton } from "@/components/Skeletons";

// karta se dogeneruje až při otevření — jako na ostatních obrazovkách
const CardModal = dynamic(() => import("@/components/CardModal"), { ssr: false });

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
function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
/** minuty od půlnoci lokálního času */
function minOfDay(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

const DAY_LABEL = ["Po", "Út", "St", "Čt", "Pá", "So", "Ne"];
const SLOT_MIN = 30; // krok přetažení
const PX_PER_MIN = 56 / 60; // hodina = 56 px

type PlannedTask = Task & {
  workspaces?: { name: string } | null;
  task_assignees?: { user_id: string }[];
};

/** Načtený týden pro stale-while-revalidate cache (lib/viewCache). */
type DaySnapshot = {
  planned: PlannedTask[];
  due: PlannedTask[];
  candidates: PlannedTask[];
};

type DragData = {
  taskId: string;
  title: string;
  durationMin: number;
  task: PlannedTask;
  resize?: boolean;
};

/** Kandidát v pravém panelu — přetažitelný na hodinovou osu. */
function CandidateRow({
  task,
  open,
  children,
  onToggle,
}: {
  task: PlannedTask;
  open: boolean;
  children: React.ReactNode;
  onToggle: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `cand-${task.id}`,
    data: {
      taskId: task.id,
      title: task.title,
      durationMin: 60,
      task,
    } satisfies DragData,
  });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`rounded-lg ${isDragging ? "opacity-40" : ""} ${
        open ? "bg-accent-soft/50" : "hover:bg-black/[.03]"
      }`}
    >
      <button
        onClick={onToggle}
        className="flex w-full cursor-grab items-center gap-2 px-2 py-1.5 text-left"
      >
        <span
          aria-hidden
          style={{ background: projectColor(task.workspace_id) }}
          className="h-6 w-1 shrink-0 rounded-full"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{task.title}</span>
          <span className="flex items-center gap-1 text-[11px] text-ink-soft/70">
            <span className="font-medium">{task.workspaces?.name}</span>
            <span aria-hidden>·</span>
            <span className="truncate">{task.projects?.name ?? "Bez projektu"}</span>
            {task.due_date && (
              <span className="ml-auto shrink-0">
                do{" "}
                {new Date(`${task.due_date}T00:00`).toLocaleDateString("cs-CZ", {
                  day: "numeric",
                  month: "numeric",
                })}
              </span>
            )}
          </span>
        </span>
      </button>
      {children}
    </div>
  );
}

/** Naplánovaný blok na ose — přetažením se přesune, spodní hranou se
    roztáhne délka, klik otevře kartu. */
function PlannedBlock({
  task,
  top,
  height,
  resizeDeltaMin,
  active,
  past,
  onOpen,
  onUnplan,
}: {
  task: PlannedTask;
  top: number;
  height: number;
  resizeDeltaMin: number;
  active: boolean;
  past: boolean;
  onOpen: () => void;
  onUnplan: () => void;
}) {
  const durationMin = Math.max(
    SLOT_MIN,
    Math.round(
      (new Date(task.planned_end!).getTime() -
        new Date(task.planned_start!).getTime()) /
        60000
    )
  );
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `plan-${task.id}`,
    data: { taskId: task.id, title: task.title, durationMin, task } satisfies DragData,
  });
  // destrukturováno — `rz.setNodeRef` v renderu lint bral jako čtení refu
  const {
    attributes: rzAttributes,
    listeners: rzListeners,
    setNodeRef: rzSetNodeRef,
  } = useDraggable({
    id: `resize-${task.id}`,
    data: {
      taskId: task.id,
      title: task.title,
      durationMin,
      task,
      resize: true,
    } satisfies DragData,
  });
  const liveHeight = Math.max(height + resizeDeltaMin * PX_PER_MIN, 26);
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onOpen}
      style={{
        top,
        height: liveHeight,
        borderLeftColor: projectColor(task.workspace_id),
      }}
      className={`absolute left-14 right-2 z-10 cursor-grab overflow-hidden rounded-md border border-line border-l-4 bg-surface px-2 py-0.5 shadow-sm hover:border-accent/50 ${
        isDragging ? "opacity-40" : ""
      } ${past && !active ? "opacity-60" : ""} ${
        active || resizeDeltaMin !== 0 ? "ring-1 ring-accent/60" : ""
      }`}
    >
      <span className="flex items-baseline gap-2 text-xs">
        <span
          className={`shrink-0 font-mono tabular-nums ${
            active ? "font-semibold text-accent" : "text-ink-soft"
          }`}
        >
          {hhmm(task.planned_start!)}–
          {resizeDeltaMin !== 0
            ? hhmm(
                new Date(
                  new Date(task.planned_end!).getTime() + resizeDeltaMin * 60000
                ).toISOString()
              )
            : hhmm(task.planned_end!)}
        </span>
        <span
          className={`min-w-0 flex-1 truncate text-sm ${
            task.completed_at ? "text-ink-soft/60 line-through" : ""
          }`}
        >
          {task.title}
        </span>
        {active && (
          <span className="shrink-0 rounded-full bg-accent/15 px-1.5 text-[10px] font-medium text-accent">
            teď
          </span>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onUnplan();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="Odnaplánovat"
          title="Odnaplánovat"
          className="shrink-0 rounded px-1 leading-none text-ink-soft/40 hover:bg-black/5 hover:text-red-600"
        >
          ✕
        </button>
      </span>
      {/* úchyt pro změnu délky — stopPropagation, aby netáhl celý blok */}
      <div
        ref={rzSetNodeRef}
        {...rzAttributes}
        {...rzListeners}
        onPointerDown={(e) => {
          (rzListeners?.onPointerDown as ((ev: unknown) => void) | undefined)?.(e);
          e.stopPropagation();
        }}
        onClick={(e) => e.stopPropagation()}
        aria-label="Změnit délku"
        className="absolute inset-x-0 bottom-0 h-2.5 cursor-ns-resize"
      >
        <span
          aria-hidden
          className="mx-auto mt-1 block h-1 w-10 rounded-full bg-black/10 hover:bg-accent/40"
        />
      </div>
    </div>
  );
}

/** Droppable slot (30 min) na hodinové ose. */
function Slot({ min, top }: { min: number; top: number }) {
  const { setNodeRef, isOver } = useDroppable({ id: `min:${min}` });
  return (
    <div
      ref={setNodeRef}
      style={{ top, height: SLOT_MIN * PX_PER_MIN }}
      className={`absolute left-12 right-0 ${isOver ? "bg-accent/10" : ""}`}
    />
  );
}

/** Můj den: hodinová osa s drag & drop plánováním. Kartu z pravého panelu
    přetáhneš na hodinu (výchozí délka 1 h), naplánovaný blok jde přetáhnout
    jinam; přesné minuty přes rozbalení v panelu nebo na kartě (🗓 Plán). */
export default function MyDayView({
  wsId,
  userId,
}: {
  wsId: string;
  userId: string;
}) {
  const supabase = createClient();
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const [day, setDay] = useState(() => isoDay(new Date()));
  // poslední načtený týden (stale-while-revalidate): návrat na Můj den i
  // listování týdny ukáže známá data hned, čerstvá dojedou na pozadí
  const cacheKey = `day:${userId}:${isoDay(weekStart)}`;
  const cached = cacheGet<DaySnapshot>(cacheKey);
  const [planned, setPlanned] = useState<PlannedTask[]>(cached?.planned ?? []);
  const [due, setDue] = useState<PlannedTask[]>(cached?.due ?? []);
  const [candidates, setCandidates] = useState<PlannedTask[]>(cached?.candidates ?? []);
  const [query, setQuery] = useState("");
  const [fProject, setFProject] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [planFor, setPlanFor] = useState<string | null>(null);
  const [planFrom, setPlanFrom] = useState("09:00");
  const [planTo, setPlanTo] = useState("10:00");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!cached);
  const [loadError, setLoadError] = useState(false);
  // pořadí načítání: při listování týdny nesmí pozdě doběhlý dřívější týden
  // přepsat ten, na který se právě díváš
  const loadSeq = useRef(0);
  const [dragging, setDragging] = useState<DragData | null>(null);
  const [resizing, setResizing] = useState<{
    taskId: string;
    deltaMin: number;
  } | null>(null);
  const [openTaskCard, setOpenTaskCard] = useState<PlannedTask | null>(null);
  const [cardMembers, setCardMembers] = useState<Membership[]>([]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } })
  );

  const weekEnd = useMemo(() => addDays(weekStart, 7), [weekStart]);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const fromISO = weekStart.toISOString();
    const toISO = weekEnd.toISOString();
    const fromDay = isoDay(weekStart);
    const toDay = isoDay(weekEnd);
    const [mineRes, createdRes, dueRes, candRes] = await Promise.all([
      supabase
        .from("task_assignees")
        .select(
          "tasks!inner(*, projects(name), workspaces(name), task_assignees(user_id))"
        )
        .eq("user_id", userId)
        .gte("tasks.planned_start", fromISO)
        .lt("tasks.planned_start", toISO),
      supabase
        .from("tasks")
        .select("*, projects(name), workspaces(name), task_assignees(user_id)")
        .eq("created_by", userId)
        .gte("planned_start", fromISO)
        .lt("planned_start", toISO),
      supabase
        .from("task_assignees")
        .select("tasks!inner(*, projects(name), workspaces(name))")
        .eq("user_id", userId)
        .is("tasks.completed_at", null)
        .is("tasks.planned_start", null)
        .gte("tasks.due_date", fromDay)
        .lt("tasks.due_date", toDay),
      supabase
        .from("task_assignees")
        .select("tasks!inner(*, projects(name), workspaces(name))")
        .eq("user_id", userId)
        .is("tasks.completed_at", null)
        .is("tasks.planned_start", null)
        .is("tasks.parent_id", null),
    ]);
    if (seq !== loadSeq.current) return;
    // chyba ≠ prázdný týden: necháme, co je vidět, a nic necachujeme
    if (mineRes.error || createdRes.error || dueRes.error || candRes.error) {
      setLoading(false);
      setLoadError(true);
      return;
    }
    setLoadError(false);
    const mine = ((mineRes.data ?? []) as unknown as { tasks: PlannedTask }[]).map(
      (r) => r.tasks
    );
    const created = ((createdRes.data ?? []) as unknown as PlannedTask[]).filter(
      (t) => (t.task_assignees ?? []).length === 0
    );
    const byId = new Map<string, PlannedTask>();
    for (const t of [...mine, ...created]) byId.set(t.id, t);
    const nextPlanned = [...byId.values()].sort((a, b) =>
      (a.planned_start ?? "").localeCompare(b.planned_start ?? "")
    );
    const nextDue = (
      (dueRes.data ?? []) as unknown as { tasks: PlannedTask }[]
    ).map((r) => r.tasks);
    const nextCandidates = ((candRes.data ?? []) as unknown as { tasks: PlannedTask }[])
      .map((r) => r.tasks)
      .filter((t) => !t.on_hold)
      .sort(
        (a, b) =>
          (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999") ||
          (a.priority ?? 4) - (b.priority ?? 4) ||
          a.title.localeCompare(b.title, "cs")
      );
    setPlanned(nextPlanned);
    setDue(nextDue);
    setCandidates(nextCandidates);
    setLoading(false);
    cacheSet(`day:${userId}:${fromDay}`, {
      planned: nextPlanned,
      due: nextDue,
      candidates: nextCandidates,
    } satisfies DaySnapshot);
  }, [supabase, userId, weekStart, weekEnd]);

  useEffect(() => {
    // listování týdny: známý týden ukázat hned z cache, pak přenačíst
    const known = cacheGet<DaySnapshot>(cacheKey);
    if (known) {
      setPlanned(known.planned);
      setDue(known.due);
      setCandidates(known.candidates);
      setLoading(false);
    }
    setLoadError(false); // chyba patřila předchozímu týdnu
    load();
  }, [load, cacheKey]);

  const today = isoDay(new Date());
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const plannedCount = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of planned) {
      const key = isoDay(new Date(t.planned_start!));
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [planned]);

  const dayPlanned = planned.filter(
    (t) => isoDay(new Date(t.planned_start!)) === day
  );
  const dayDue = due.filter((t) => t.due_date === day);
  const totalSeconds = dayPlanned.reduce(
    (sum, t) =>
      sum +
      (new Date(t.planned_end!).getTime() - new Date(t.planned_start!).getTime()) /
        1000,
    0
  );
  const nowISO = new Date().toISOString();

  // rozsah osy: 6–20, roztažený podle naplánovaných bloků
  const startHour = Math.min(
    6,
    ...dayPlanned.map((t) => Math.floor(minOfDay(t.planned_start!) / 60))
  );
  const endHour = Math.max(
    20,
    ...dayPlanned.map((t) => Math.ceil((minOfDay(t.planned_end!) || 1) / 60))
  );
  const startMin = startHour * 60;
  const gridHeight = (endHour - startHour) * 60 * PX_PER_MIN;

  /** Optimisticky vloží/posune blok v lokálním stavu — UI reaguje hned,
      zápis do DB a kalendáře doběhne na pozadí. */
  const upsertLocal = useCallback(
    (task: PlannedTask, startISO: string, endISO: string) => {
      const updated = { ...task, planned_start: startISO, planned_end: endISO };
      setPlanned((prev) =>
        [...prev.filter((p) => p.id !== task.id), updated].sort((a, b) =>
          (a.planned_start ?? "").localeCompare(b.planned_start ?? "")
        )
      );
      setCandidates((prev) => prev.filter((c) => c.id !== task.id));
      setDue((prev) => prev.filter((c) => c.id !== task.id));
    },
    []
  );

  /** Uloží nové okno: nejdřív lokálně (hned vidět), pak DB + kalendář. */
  async function persistPlan(task: PlannedTask, startISO: string, endISO: string) {
    upsertLocal(task, startISO, endISO);
    setPlanFor(null);
    const { error } = await supabase
      .from("tasks")
      .update({ planned_start: startISO, planned_end: endISO })
      .eq("id", task.id);
    if (error) {
      toast("Naplánování se nezdařilo.", "error");
      load(); // vrátit skutečný stav
      return;
    }
    toast(`Naplánováno: ${task.title} (${hhmm(startISO)}–${hhmm(endISO)})`);
    // kalendář nečekáme — jen případnou chybu ohlásíme; akce může i spadnout
    // (po nasazení staré ID akce, výpadek sítě)
    syncTaskCalendar(task.id)
      .then((res) => {
        if (res.error) toast(res.error, "error");
      })
      .catch(() => toast("Kalendář se nepodařilo aktualizovat.", "error"));
  }

  function applyPlan(task: PlannedTask, from: string, to: string) {
    persistPlan(
      task,
      new Date(`${day}T${from}`).toISOString(),
      new Date(`${day}T${to}`).toISOString()
    );
  }

  function onDragStart(e: DragStartEvent) {
    const data = e.active.data.current as DragData | undefined;
    if (data?.resize) return; // resize nemá chip v overlay
    setDragging(data ?? null);
  }

  function onDragMove(e: DragMoveEvent) {
    const data = e.active.data.current as DragData | undefined;
    if (!data?.resize) return;
    const snapped = Math.round(e.delta.y / PX_PER_MIN / 15) * 15;
    const deltaMin = Math.max(snapped, 15 - data.durationMin); // min. 15 minut
    setResizing((prev) =>
      prev?.taskId === data.taskId && prev.deltaMin === deltaMin
        ? prev
        : { taskId: data.taskId, deltaMin }
    );
  }

  function onDragEnd(e: DragEndEvent) {
    const data = e.active.data.current as DragData | undefined;
    setDragging(null);
    setResizing(null);
    if (!data) return;

    if (data.resize) {
      const snapped = Math.round(e.delta.y / PX_PER_MIN / 15) * 15;
      const deltaMin = Math.max(snapped, 15 - data.durationMin);
      if (deltaMin === 0) return;
      const startISO = data.task.planned_start!;
      const endISO = new Date(
        new Date(data.task.planned_end!).getTime() + deltaMin * 60000
      ).toISOString();
      persistPlan(data.task, startISO, endISO);
      return;
    }

    const overId = e.over?.id;
    if (typeof overId !== "string" || !overId.startsWith("min:")) return;
    const start = Number(overId.slice(4));
    const end = Math.min(start + data.durationMin, 24 * 60);
    const f = `${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`;
    const t = `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
    applyPlan(data.task, f, t);
  }

  /** Zruší plánované okno: blok zmizí hned, úkol se vrátí mezi kandidáty,
      událost v kalendáři se smaže na pozadí. */
  async function unplan(task: PlannedTask) {
    setPlanned((prev) => prev.filter((p) => p.id !== task.id));
    if (!task.completed_at && !task.on_hold && !task.parent_id) {
      const cleared = { ...task, planned_start: null, planned_end: null };
      setCandidates((prev) => [
        cleared,
        ...prev.filter((c) => c.id !== task.id),
      ]);
    }
    const { error } = await supabase
      .from("tasks")
      .update({ planned_start: null, planned_end: null })
      .eq("id", task.id);
    if (error) {
      toast("Odnaplánování se nezdařilo.", "error");
      load();
      return;
    }
    toast(`Odnaplánováno: ${task.title}`);
    syncTaskCalendar(task.id)
      .then((res) => {
        if (res.error) toast(res.error, "error");
      })
      .catch(() => toast("Kalendář se nepodařilo aktualizovat.", "error"));
  }

  /** Otevře kartu úkolu v modalu nad Mým dnem (nenaviguje do projektu). */
  async function openCard(task: PlannedTask) {
    const { data, error } = await supabase
      .from("workspace_members")
      .select(
        "*, profiles(id, email, full_name, is_super_admin, avatar_initials, avatar_color, tag_name)"
      )
      .eq("workspace_id", task.workspace_id);
    // bez členů by karta ukázala řešitele jako „?" i špatné volby — neotevírat
    if (error) {
      toast("Kartu se nepodařilo otevřít.", "error");
      return;
    }
    setCardMembers((data as unknown as Membership[]) ?? []);
    setOpenTaskCard(task);
  }

  function openPlan(taskId: string) {
    if (planFor === taskId) {
      setPlanFor(null);
      return;
    }
    const last = dayPlanned[dayPlanned.length - 1];
    const start = last ? new Date(last.planned_end!) : new Date(`${day}T09:00`);
    if (start.getHours() < 8) start.setHours(9, 0, 0, 0);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    setPlanFrom(hhmm(start.toISOString()));
    setPlanTo(hhmm(end.toISOString()));
    setPlanFor(taskId);
  }

  async function addTask(e: React.FormEvent) {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    const { data, error } = await supabase
      .from("tasks")
      .insert({
        workspace_id: wsId,
        title,
        triaged_at: new Date().toISOString(), // vědomě založený — nepatří do Inboxu
      })
      .select("id")
      .single();
    if (error || !data) {
      setBusy(false);
      toast("Úkol se nepodařilo přidat.", "error");
      return;
    }
    await supabase
      .from("task_assignees")
      .insert({ task_id: data.id, user_id: userId });
    setNewTitle("");
    setBusy(false);
    toast(`Úkol přidán: ${title} — přetáhni ho na osu.`);
    load();
  }

  if (loading) return <MyDaySkeleton />;

  const projectOptions: { key: string; label: string }[] = [];
  for (const t of candidates) {
    const key = t.project_id ?? "none";
    if (!projectOptions.some((o) => o.key === key))
      projectOptions.push({
        key,
        label: t.project_id
          ? `${t.projects?.name ?? "projekt"} (${t.workspaces?.name ?? "?"})`
          : "Bez projektu",
      });
  }
  projectOptions.sort((a, b) => a.label.localeCompare(b.label, "cs"));

  const q = query.trim().toLowerCase();
  const results = candidates
    .filter((t) => !fProject || (t.project_id ?? "none") === fProject)
    .filter(
      (t) =>
        !q ||
        t.title.toLowerCase().includes(q) ||
        (t.projects?.name ?? "").toLowerCase().includes(q)
    )
    .slice(0, 30);

  const slots: number[] = [];
  for (let m = startMin; m < endHour * 60; m += SLOT_MIN) slots.push(m);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
    >
    <div className="grid w-full items-start gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
    <div className="min-w-0 space-y-4">
      <div>
        <h1 className="font-display text-lg font-semibold">Můj den</h1>
        <p className="text-xs text-ink-soft/70">
          {new Date(`${day}T00:00`).toLocaleDateString("cs-CZ", {
            weekday: "long",
            day: "numeric",
            month: "long",
          })}
          {dayPlanned.length > 0 && (
            <>
              {" · "}naplánováno {dayPlanned.length}{" "}
              {dayPlanned.length === 1 ? "úkol" : dayPlanned.length < 5 ? "úkoly" : "úkolů"}{" "}
              · <span className="font-mono">{fmtClock(totalSeconds)}</span> h
            </>
          )}
          {" · "}úkol přetáhni z panelu vpravo na hodinu
        </p>
      </div>

      {/* chyba ≠ prázdný týden; „poslední známý stav" jen u týdne z cache */}
      {loadError && (
        <LoadError
          onRetry={load}
          message={cached ? "Týden se nepodařilo obnovit." : "Týden se nepodařilo načíst."}
          stale={!!cached}
        />
      )}

      {/* pruh dnů */}
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
            const n = plannedCount.get(key) ?? 0;
            const selected = key === day;
            return (
              <button
                key={key}
                onClick={() => setDay(key)}
                aria-pressed={selected}
                className={`flex flex-col items-center rounded-lg px-1 py-1.5 text-xs transition-colors ${
                  selected ? "bg-accent text-white" : "hover:bg-black/5"
                }`}
              >
                <span
                  className={
                    selected ? "" : key === today ? "font-semibold" : "text-ink-soft/70"
                  }
                >
                  {DAY_LABEL[i]} {d.getDate()}.
                </span>
                <span
                  className={`font-mono text-[11px] ${
                    selected
                      ? "text-white/80"
                      : n > 0
                        ? "text-accent"
                        : "text-ink-soft/40"
                  }`}
                >
                  {n > 0 ? n : "—"}
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

      {/* hodinová osa s droppable sloty */}
      <div className="panel overflow-hidden">
        <div className="relative" style={{ height: gridHeight }}>
          {Array.from({ length: endHour - startHour }, (_, i) => {
            const h = startHour + i;
            const top = (h * 60 - startMin) * PX_PER_MIN;
            return (
              <div key={h}>
                <div
                  aria-hidden
                  style={{ top }}
                  className="absolute left-0 right-0 border-t border-line/50"
                />
                <span
                  style={{ top: top + 2 }}
                  className="absolute left-2 font-mono text-[10px] text-ink-soft/50"
                >
                  {String(h).padStart(2, "0")}:00
                </span>
              </div>
            );
          })}
          {slots.map((m) => (
            <Slot key={m} min={m} top={(m - startMin) * PX_PER_MIN} />
          ))}
          {dayPlanned.map((t) => {
            const s = minOfDay(t.planned_start!);
            const e = Math.max(minOfDay(t.planned_end!), s + 10);
            const active =
              !t.completed_at &&
              t.planned_start! <= nowISO &&
              nowISO < t.planned_end!;
            return (
              <PlannedBlock
                key={t.id}
                task={t}
                top={(s - startMin) * PX_PER_MIN}
                height={(e - s) * PX_PER_MIN}
                resizeDeltaMin={resizing?.taskId === t.id ? resizing.deltaMin : 0}
                active={active}
                past={t.planned_end! < nowISO}
                onOpen={() => openCard(t)}
                onUnplan={() => unplan(t)}
              />
            );
          })}
        </div>
      </div>

      {/* termíny dne (nenaplánované) */}
      {dayDue.length > 0 && (
        <div className="panel">
          <h2 className="border-b border-line/70 px-3 py-2 text-sm font-semibold">
            Termín dnes{" "}
            <span className="text-xs font-normal text-ink-soft/60">
              {dayDue.length} · bez naplánovaného času
            </span>
          </h2>
          <div className="divide-y divide-line/50">
            {dayDue.map((t) => (
              <button
                key={t.id}
                onClick={() => openCard(t)}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-black/[.02]"
              >
                <span
                  aria-hidden
                  style={{ background: projectColor(t.workspace_id) }}
                  className="h-7 w-1 shrink-0 rounded-full"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{t.title}</span>
                  <span className="flex items-center gap-1.5 text-xs text-ink-soft/70">
                    <span className="font-medium">{t.workspaces?.name}</span>
                    <span aria-hidden>·</span>
                    <ProjectDot id={t.project_id} className="h-2 w-2" />
                    <span className="truncate">
                      {t.projects?.name ?? "Bez projektu"}
                    </span>
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>

    {/* pravý sloupec: najít / založit úkol a naplánovat */}
    <aside className="panel space-y-3 p-3">
      <h2 className="text-sm font-semibold">Naplánovat úkol</h2>

      <form onSubmit={addTask} className="flex gap-1.5">
        <input
          type="text"
          placeholder="Nový úkol…"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          className="input min-w-0 flex-1 px-2 py-1.5 text-sm"
        />
        <button
          type="submit"
          disabled={busy || !newTitle.trim()}
          className="btn-primary shrink-0 px-3 py-1 text-sm disabled:opacity-60"
        >
          +
        </button>
      </form>

      <input
        type="search"
        placeholder="Hledat v mých úkolech…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="input w-full px-2 py-1.5 text-sm"
      />

      {projectOptions.length > 1 && (
        <select
          value={fProject}
          onChange={(e) => setFProject(e.target.value)}
          aria-label="Filtr projektu"
          className="input w-full px-2 py-1.5 text-sm"
        >
          <option value="">Projekt: vše</option>
          {projectOptions.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      )}

      {results.length === 0 ? (
        <p className="py-4 text-center text-xs text-ink-soft/60">
          {q
            ? "Nic nenalezeno."
            : loadError && candidates.length === 0
              ? "Úkoly se nepodařilo načíst."
              : "Žádné nenaplánované úkoly. 🎉"}
        </p>
      ) : (
        <div className="-mx-1 max-h-[30rem] space-y-0.5 overflow-y-auto px-1">
          {results.map((t) => (
            <CandidateRow
              key={t.id}
              task={t}
              open={planFor === t.id}
              onToggle={() => openPlan(t.id)}
            >
              {planFor === t.id && (
                <div className="flex items-center gap-1.5 px-2 pb-2">
                  <input
                    type="time"
                    value={planFrom}
                    onChange={(e) => setPlanFrom(e.target.value)}
                    aria-label="Plán od"
                    className="input px-1.5 py-1 text-xs"
                  />
                  <span className="text-ink-soft/50">–</span>
                  <input
                    type="time"
                    value={planTo}
                    onChange={(e) => setPlanTo(e.target.value)}
                    aria-label="Plán do"
                    className="input px-1.5 py-1 text-xs"
                  />
                  <button
                    onClick={() => {
                      if (!planFrom || !planTo || planTo <= planFrom) {
                        toast("Konec plánu musí být po začátku.", "error");
                        return;
                      }
                      applyPlan(t, planFrom, planTo);
                    }}
                    disabled={busy}
                    className="btn-primary ml-auto px-2.5 py-1 text-xs disabled:opacity-60"
                  >
                    Naplánovat ✓
                  </button>
                </div>
              )}
            </CandidateRow>
          ))}
        </div>
      )}
    </aside>
    </div>

    <DragOverlay>
      {dragging && (
        <div className="rounded-lg border border-accent/50 bg-surface px-3 py-1.5 text-sm shadow-lg">
          {dragging.title}
        </div>
      )}
    </DragOverlay>

    {openTaskCard && (
      <CardModal
        task={openTaskCard}
        members={cardMembers}
        userId={userId}
        onClose={() => setOpenTaskCard(null)}
        onChanged={() => {
          setOpenTaskCard(null);
          load();
        }}
      />
    )}
    </DndContext>
  );
}
