"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import dynamic from "next/dynamic";
import { createClient } from "@/lib/supabase/client";
import { posBetween } from "@/lib/position";
import { startTimer } from "@/lib/timer";
import { toast } from "@/lib/toast";
import { pingNotifyEmails } from "@/lib/notify";
import { confirmDialog } from "@/lib/confirm";
import { TASKS_CHANGED_EVENT } from "@/lib/tasksChanged";
import { cacheGet, cacheSet } from "@/lib/viewCache";
import { PRIORITIES } from "@/lib/priority";
import type { BoardColumn, Label, Membership, Task } from "@/lib/types";
import BoardCard from "@/components/BoardCard";
import { ProjectDot } from "@/components/ProjectPicker";
import { BoardSkeleton } from "@/components/Skeletons";
import LoadError from "@/components/LoadError";

// Modal karty mimo základní bundle nástěnky — načte se až při otevření.
const CardModal = dynamic(() => import("@/components/CardModal"), { ssr: false });

type CardsByCol = Record<string, Task[]>;

type Ghost = { id: string; name: string; avatar_initials?: string; avatar_color?: string };

/** Poslední načtený stav nástěnky (stale-while-revalidate, lib/viewCache):
    návrat na nástěnku ji ukáže okamžitě, čerstvá data dojedou na pozadí. */
type BoardSnapshot = {
  columns: BoardColumn[];
  cards: CardsByCol;
  orphans: Task[];
  holdTasks: Task[];
  waitingTasks: Task[];
  doneTasks: Task[];
  members: Membership[];
  cardLabels: Record<string, Label[]>;
  cardAssignees: Record<string, string[]>;
  cardWaiting: Record<string, string>;
  cardGhosts: Record<string, Ghost[]>;
  subCounts: Record<string, { done: number; total: number }>;
  wsLabels: Label[];
};

const COL_PREFIX = "col:";

// Automatické (virtuální) sloupce na konci každé nástěnky — nejsou v DB.
// Hold = uspané karty (flag on_hold), Waiting on = otevřené karty
// s follow-upem, Done = dokončené karty.
const HOLD_COL = "__hold";
const WAITING_COL = "__waiting";
const DONE_COL = "__done";
// hotové karty po dávkách od nejnovějších — starší projekty jich mají stovky
// a nástěnka je dřív stahovala a vykreslovala všechny
const DONE_PAGE = 50;

function colDndId(id: string) {
  return `${COL_PREFIX}${id}`;
}

function isColId(id: string) {
  return id.startsWith(COL_PREFIX);
}

function stripCol(id: string) {
  return id.slice(COL_PREFIX.length);
}

export default function BoardView({
  wsId,
  projectId,
  projectName,
  userId,
  isAdmin,
  initialTaskId,
}: {
  wsId: string;
  projectId: string;
  projectName: string;
  userId: string;
  isAdmin: boolean;
  /** sdílený odkaz (/t/<id>): po načtení rovnou otevřít kartu úkolu */
  initialTaskId?: string;
}) {
  const supabase = createClient();
  // viditelnost karet závisí na uživateli (Task force filtr) → klíč i s userId
  const cacheKey = `board:${projectId}:${userId}`;
  const cached = cacheGet<BoardSnapshot>(cacheKey);
  const [columns, setColumns] = useState<BoardColumn[]>(cached?.columns ?? []);
  const [cards, setCards] = useState<CardsByCol>(cached?.cards ?? {});
  const [orphans, setOrphans] = useState<Task[]>(cached?.orphans ?? []);
  // automatické sloupce: uspané karty, karty s follow-upem a hotové karty
  const [holdTasks, setHoldTasks] = useState<Task[]>(cached?.holdTasks ?? []);
  const [waitingTasks, setWaitingTasks] = useState<Task[]>(cached?.waitingTasks ?? []);
  const [doneTasks, setDoneTasks] = useState<Task[]>(cached?.doneTasks ?? []);
  const [doneLimit, setDoneLimit] = useState(DONE_PAGE);
  const [doneMore, setDoneMore] = useState(false); // v DB jsou starší hotové
  const [members, setMembers] = useState<Membership[]>(cached?.members ?? []);
  const [loading, setLoading] = useState(!cached);
  const [loadError, setLoadError] = useState(false);
  // Pořadí načítání: starší odpověď nesmí přepsat novější. Optimistický
  // přesun (drag & drop) sekvenci posune taky — načtení rozjeté před ním by
  // po doběhnutí vrátilo kartu na původní místo (viz discardLoads).
  const loadSeq = useRef(0);
  const loadsRunning = useRef(0);
  // přesun zahodil rozjeté načtení → po uložení přesunu načíst znovu
  const reloadAfterMove = useRef(false);
  // Enter dvakrát rychle za sebou nesmí sloupec / kartu založit dvakrát
  const adding = useRef(false);
  const [openTask, setOpenTask] = useState<Task | null>(null);
  const [activeCard, setActiveCard] = useState<Task | null>(null);

  // sdílený odkaz: jednorázově otevřít kartu z ?task=
  const sharedOpened = useRef(false);
  useEffect(() => {
    if (!initialTaskId || sharedOpened.current) return;
    sharedOpened.current = true;
    supabase
      .from("tasks")
      .select("*")
      .eq("id", initialTaskId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (data) setOpenTask(data as Task);
        // výpadek spojení ≠ „úkol neexistuje"
        else if (error) toast("Úkol se nepodařilo načíst.", "error");
        else toast("Úkol nenalezen nebo k němu nemáš přístup.", "error");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTaskId]);
  const [newColumnName, setNewColumnName] = useState("");
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [newCardTitle, setNewCardTitle] = useState("");
  const [editingCol, setEditingCol] = useState<string | null>(null);
  const [editColName, setEditColName] = useState("");
  const [cardLabels, setCardLabels] = useState<Record<string, Label[]>>(
    cached?.cardLabels ?? {}
  );
  const [cardAssignees, setCardAssignees] = useState<Record<string, string[]>>(
    cached?.cardAssignees ?? {}
  );
  const [cardWaiting, setCardWaiting] = useState<Record<string, string>>(
    cached?.cardWaiting ?? {}
  );
  const [cardGhosts, setCardGhosts] = useState<Record<string, Ghost[]>>(
    cached?.cardGhosts ?? {}
  );
  const [subCounts, setSubCounts] = useState<Record<string, { done: number; total: number }>>(
    cached?.subCounts ?? {}
  );
  const [wsLabels, setWsLabels] = useState<Label[]>(cached?.wsLabels ?? []);
  // filtry
  const [fText, setFText] = useState("");
  const [fPriority, setFPriority] = useState(0);
  const [fLabel, setFLabel] = useState("");
  const [fAssignee, setFAssignee] = useState("");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // dotyk: krátké podržení odliší tažení karty od scrollování
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    reloadAfterMove.current = false; // novější načtení zahrne vše zahozené
    loadsRunning.current++;
    const [colRes, taskRes, doneRes, memRes, subRes, labelRes, tlRes, taRes, fuRes, gaRes, grantRes] = await Promise.all([
      supabase
        .from("board_columns")
        .select("*")
        .eq("project_id", projectId)
        .order("position"),
      supabase
        .from("tasks")
        .select("*")
        .eq("project_id", projectId)
        .is("parent_id", null) // podúkoly žijí jen v modalu karty
        .is("completed_at", null)
        .order("position"),
      // hotové zvlášť: jen posledních doneLimit, count řekne, jestli je víc
      supabase
        .from("tasks")
        .select("*", { count: "exact" })
        .eq("project_id", projectId)
        .is("parent_id", null)
        .not("completed_at", "is", null)
        .order("completed_at", { ascending: false })
        .limit(doneLimit),
      supabase
        .from("workspace_members")
        .select(
          "*, profiles(id, email, full_name, is_super_admin, avatar_initials, avatar_color, tag_name)"
        )
        .eq("workspace_id", wsId),
      supabase
        .from("tasks")
        .select("parent_id, completed_at")
        .eq("project_id", projectId)
        .not("parent_id", "is", null),
      supabase.from("labels").select("*").eq("workspace_id", wsId).order("name"),
      // štítky jen karet tohoto projektu (dřív celé firmy)
      supabase
        .from("task_labels")
        .select("task_id, labels!inner(id, workspace_id, name), tasks!inner(project_id)")
        .eq("tasks.project_id", projectId),
      supabase
        .from("task_assignees")
        .select("task_id, user_id, tasks!inner(project_id)")
        .eq("tasks.project_id", projectId),
      supabase
        .from("task_followups")
        .select("task_id, waiting_user_id, contacts(name), tasks!inner(project_id)")
        .eq("tasks.project_id", projectId),
      supabase
        .from("task_contact_assignees")
        .select(
          "task_id, contacts(id, name, avatar_initials, avatar_color), tasks!inner(project_id)"
        )
        .eq("tasks.project_id", projectId),
      supabase
        .from("assign_grants")
        .select("target_id")
        .eq("workspace_id", wsId)
        .eq("user_id", userId),
    ]);
    loadsRunning.current--;
    // mezitím novější načtení nebo optimistický přesun — odpověď je zastaralá
    if (seq !== loadSeq.current) return;
    // chyba ≠ prázdná nástěnka: necháme, co je vidět, a nic necachujeme
    if (
      [colRes, taskRes, doneRes, memRes, subRes, labelRes, tlRes, taRes, fuRes, gaRes, grantRes].some(
        (r) => r.error
      )
    ) {
      setLoading(false);
      setLoadError(true);
      return;
    }
    setLoadError(false);
    const cols = (colRes.data as BoardColumn[]) ?? [];
    const doneRows = (doneRes.data as Task[]) ?? [];
    const allTasks = [...((taskRes.data as Task[]) ?? []), ...doneRows];
    setDoneMore((doneRes.count ?? 0) > doneRows.length);

    const counts: Record<string, { done: number; total: number }> = {};
    for (const sub of subRes.data ?? []) {
      const key = sub.parent_id as string;
      counts[key] = counts[key] ?? { done: 0, total: 0 };
      counts[key].total += 1;
      if (sub.completed_at) counts[key].done += 1;
    }
    setSubCounts(counts);

    setWsLabels((labelRes.data as Label[]) ?? []);
    const byTask: Record<string, Label[]> = {};
    for (const row of tlRes.data ?? []) {
      const label = row.labels as unknown as Label;
      if (!label) continue;
      byTask[row.task_id] = [...(byTask[row.task_id] ?? []), label];
    }
    setCardLabels(byTask);

    const assigneesByTask: Record<string, string[]> = {};
    for (const row of taRes.data ?? []) {
      assigneesByTask[row.task_id] = [
        ...(assigneesByTask[row.task_id] ?? []),
        row.user_id as string,
      ];
    }
    setCardAssignees(assigneesByTask);

    // štítek „čeká na X" — jméno člena z memRes, kontaktu z embedded contacts
    const mems = (memRes.data as unknown as Membership[]) ?? [];
    const waitingByTask: Record<string, string> = {};
    for (const row of fuRes.data ?? []) {
      const contact = row.contacts as unknown as { name: string } | null;
      const member = row.waiting_user_id
        ? mems.find((m) => m.user_id === row.waiting_user_id)
        : null;
      const name = row.waiting_user_id
        ? member?.profiles?.full_name || member?.profiles?.email
        : contact?.name;
      // „—" = follow-up bez osoby (ruční přetažení do Waiting on)
      waitingByTask[row.task_id as string] = name || "—";
    }
    setCardWaiting(waitingByTask);

    // duší řešitelé — jen evidence na kartě (avatar se jménem kontaktu)
    const ghostsByTask: Record<
      string,
      { id: string; name: string; avatar_initials?: string; avatar_color?: string }[]
    > = {};
    for (const row of gaRes.data ?? []) {
      const contact = row.contacts as unknown as {
        id: string;
        name: string;
        avatar_initials?: string;
        avatar_color?: string;
      } | null;
      if (!contact) continue;
      ghostsByTask[row.task_id as string] = [
        ...(ghostsByTask[row.task_id as string] ?? []),
        contact,
      ];
    }
    setCardGhosts(ghostsByTask);

    // Nástěnka jako Task force: člen vidí jen úkoly svého týmu — svoje
    // (autor/řešitel/vedoucí) a úkoly lidí, kterým smí zadávat (granty).
    // Admin vidí celou nástěnku.
    const team = new Set([
      userId,
      ...((grantRes.data ?? []).map((r) => r.target_id as string)),
    ]);
    const tasks = isAdmin
      ? allTasks
      : allTasks.filter(
          (t) =>
            t.created_by === userId ||
            t.lead_id === userId ||
            (assigneesByTask[t.id] ?? []).some((id) => team.has(id))
        );

    // automatické sloupce: hotové karty → Done, uspané → Hold, otevřené
    // s follow-upem → Waiting on; v běžných sloupcích zůstává jen zbytek
    const done = tasks
      .filter((t) => t.completed_at)
      .sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));
    const hold = tasks.filter((t) => !t.completed_at && t.on_hold);
    const waiting = tasks.filter(
      (t) => !t.completed_at && !t.on_hold && waitingByTask[t.id]
    );
    const boardTasks = tasks.filter(
      (t) => !t.completed_at && !t.on_hold && !waitingByTask[t.id]
    );
    setDoneTasks(done);
    setHoldTasks(hold);
    setWaitingTasks(waiting);

    const byCol: CardsByCol = {};
    const lost: Task[] = [];
    for (const col of cols) byCol[col.id] = [];
    for (const task of boardTasks) {
      if (task.column_id && byCol[task.column_id]) byCol[task.column_id].push(task);
      else if (cols[0]) byCol[cols[0].id].push(task); // karta bez sloupce → první sloupec
      else lost.push(task); // žádné sloupce neexistují — karty nesmí zmizet
    }
    setColumns(cols);
    setCards(byCol);
    setOrphans(lost);
    setMembers(mems);
    setLoading(false);
    cacheSet(cacheKey, {
      columns: cols,
      cards: byCol,
      orphans: lost,
      holdTasks: hold,
      waitingTasks: waiting,
      doneTasks: done,
      members: mems,
      cardLabels: byTask,
      cardAssignees: assigneesByTask,
      cardWaiting: waitingByTask,
      cardGhosts: ghostsByTask,
      subCounts: counts,
      wsLabels: (labelRes.data as Label[]) ?? [],
    } satisfies BoardSnapshot);
  }, [supabase, projectId, wsId, userId, isAdmin, cacheKey, doneLimit]);

  useEffect(() => {
    load();
    // nový úkol z plovoucího „+" v layoutu — přenačti nástěnku
    const onChanged = () => load();
    window.addEventListener(TASKS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(TASKS_CHANGED_EVENT, onChanged);
  }, [load]);

  // stabilní handlery pro karty — bez nich by memo(BoardCard) nefungovalo
  const openCard = useCallback((task: Task) => setOpenTask(task), []);
  const startCard = useCallback(
    (task: Task) =>
      startTimer(supabase, userId, {
        workspace_id: wsId,
        project_id: projectId,
        task_id: task.id,
        task_title: task.title,
      }),
    [supabase, userId, wsId, projectId]
  );

  // ---------------------------------------------------------------- sloupce

  async function addColumn(e: React.FormEvent) {
    e.preventDefault();
    const name = newColumnName.trim();
    if (!name || adding.current) return;
    adding.current = true;
    setNewColumnName(""); // hned prázdné — druhý Enter už nemá co odeslat
    const last = columns[columns.length - 1];
    const { error } = await supabase.from("board_columns").insert({
      workspace_id: wsId,
      project_id: projectId,
      name,
      position: posBetween(last?.position, undefined),
    });
    adding.current = false;
    if (error) {
      setNewColumnName((cur) => cur || name); // napsaný název nezahodit
      toast("Sloupec se nepodařilo přidat.", "error");
      return;
    }
    load();
  }

  function startRenameColumn(col: BoardColumn) {
    setEditingCol(col.id);
    setEditColName(col.name);
  }

  async function saveRenameColumn(col: BoardColumn) {
    const name = editColName.trim();
    setEditingCol(null);
    if (!name || name === col.name) return;
    const { error } = await supabase
      .from("board_columns")
      .update({ name })
      .eq("id", col.id);
    if (error) toast("Přejmenování se nepodařilo.", "error");
    load();
  }

  async function deleteColumn(col: BoardColumn) {
    if ((cards[col.id] ?? []).length > 0) {
      toast("Sloupec není prázdný — nejdřív přesuň karty jinam.", "error");
      return;
    }
    const ok = await confirmDialog({
      title: "Smazat sloupec?",
      message: `Sloupec „${col.name}" se smaže.`,
    });
    if (!ok) return;
    const { error } = await supabase.from("board_columns").delete().eq("id", col.id);
    if (error) toast("Smazání se nepodařilo.", "error");
    load();
  }

  // ---------------------------------------------------------------- karty

  async function addCard(colId: string, e: React.FormEvent) {
    e.preventDefault();
    const title = newCardTitle.trim();
    if (!title || adding.current) return;
    adding.current = true;
    setNewCardTitle(""); // hned prázdné — druhý Enter už nemá co odeslat
    const list = cards[colId] ?? [];
    const { error } = await supabase.from("tasks").insert({
      workspace_id: wsId,
      project_id: projectId,
      column_id: colId,
      title,
      position: posBetween(list[list.length - 1]?.position, undefined),
    });
    adding.current = false;
    if (error) {
      setNewCardTitle((cur) => cur || title); // napsaný název nezahodit
      toast("Kartu se nepodařilo přidat.", "error");
      return;
    }
    load();
  }

  function findColumnOf(cardId: string): string | undefined {
    return Object.keys(cards).find((colId) =>
      cards[colId].some((t) => t.id === cardId)
    );
  }

  // ---------------------------------------------------------------- drag & drop

  /** Před optimistickým přesunem: rozjeté načtení nese stav před ním a po
   *  doběhnutí by kartu vrátilo zpět — posun sekvence ho zahodí. Pokud nějaké
   *  běželo, po uložení přesunu se nástěnka načte znovu (reloadAfterMove). */
  function discardLoads() {
    if (loadsRunning.current > 0) reloadAfterMove.current = true;
    loadSeq.current++;
  }

  /** Optimistický přesun karty do cílového sloupce (běžného i automatického):
   *  karta zůstane tam, kam ji uživatel pustil, hned — bez čekání na server
   *  a bez optického návratu do původního sloupce. load() pak stav srovná. */
  function moveLocally(taskId: string, target: string, patch: Partial<Task>) {
    const fromCol = findColumnOf(taskId);
    const moving =
      (fromCol ? cards[fromCol]?.find((t) => t.id === taskId) : undefined) ??
      holdTasks.find((t) => t.id === taskId) ??
      waitingTasks.find((t) => t.id === taskId) ??
      doneTasks.find((t) => t.id === taskId);
    if (!moving) return;
    discardLoads();
    const next = { ...moving, ...patch };
    const drop = (list: Task[]) => list.filter((t) => t.id !== taskId);
    setCards((prev) => {
      const out: CardsByCol = {};
      for (const key of Object.keys(prev)) out[key] = drop(prev[key]);
      if (!target.startsWith("__")) out[target] = [...(out[target] ?? []), next];
      return out;
    });
    setHoldTasks((prev) => (target === HOLD_COL ? [...drop(prev), next] : drop(prev)));
    setWaitingTasks((prev) =>
      target === WAITING_COL ? [...drop(prev), next] : drop(prev)
    );
    setDoneTasks((prev) => (target === DONE_COL ? [next, ...drop(prev)] : drop(prev)));
  }

  function handleDragStart(event: DragStartEvent) {
    const id = String(event.active.id);
    if (!isColId(id)) {
      const colId = findColumnOf(id);
      setActiveCard(
        cards[colId ?? ""]?.find((t) => t.id === id) ??
          holdTasks.find((t) => t.id === id) ??
          waitingTasks.find((t) => t.id === id) ??
          null
      );
    }
  }

  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (isColId(activeId)) return; // přesun sloupců řeší až dragEnd

    const fromCol = findColumnOf(activeId);
    const toCol = isColId(overId) ? stripCol(overId) : findColumnOf(overId);
    if (!fromCol || !toCol || fromCol === toCol) return;
    if (toCol.startsWith("__")) return; // automatické sloupce řeší až dragEnd

    // optimistický přesun mezi sloupci, ať je vidět "díra"
    discardLoads();
    setCards((prev) => {
      const moving = prev[fromCol].find((t) => t.id === activeId);
      if (!moving) return prev;
      const fromList = prev[fromCol].filter((t) => t.id !== activeId);
      const toList = [...prev[toCol]];
      const overIndex = toList.findIndex((t) => t.id === overId);
      toList.splice(overIndex >= 0 ? overIndex : toList.length, 0, {
        ...moving,
        column_id: toCol,
      });
      return { ...prev, [fromCol]: fromList, [toCol]: toList };
    });
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveCard(null);
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);

    // přeřazení sloupců
    if (isColId(activeId)) {
      if (activeId === overId || !isColId(overId)) return;
      const oldIndex = columns.findIndex((c) => colDndId(c.id) === activeId);
      const newIndex = columns.findIndex((c) => colDndId(c.id) === overId);
      if (oldIndex < 0 || newIndex < 0) return;
      const reordered = arrayMove(columns, oldIndex, newIndex);
      const moved = reordered[newIndex];
      const position = posBetween(
        reordered[newIndex - 1]?.position,
        reordered[newIndex + 1]?.position
      );
      discardLoads();
      setColumns(reordered.map((c) => (c.id === moved.id ? { ...c, position } : c)));
      const { error } = await supabase
        .from("board_columns")
        .update({ position })
        .eq("id", moved.id);
      if (error) {
        toast("Přesun sloupce se neuložil — obnovuji nástěnku.", "error");
        load();
      } else if (reloadAfterMove.current) load();
      return;
    }

    // puštění karty na automatický sloupec: Waiting on založí follow-up
    // (bez osoby), Hold kartu uspí, Done dokončí
    const dropTarget = isColId(overId)
      ? stripCol(overId)
      : holdTasks.some((t) => t.id === overId)
        ? HOLD_COL
        : doneTasks.some((t) => t.id === overId)
          ? DONE_COL
          : waitingTasks.some((t) => t.id === overId)
            ? WAITING_COL
            : (findColumnOf(overId) ?? null);
    const fromHold = holdTasks.some((t) => t.id === activeId);
    const fromWaiting = waitingTasks.some((t) => t.id === activeId);
    const fromBoard = !!findColumnOf(activeId);

    if (dropTarget === WAITING_COL) {
      if (fromBoard || fromHold) {
        moveLocally(activeId, WAITING_COL, { on_hold: false });
        // karta z Hold se probudí; follow-up (bez osoby) jen pokud už nemá
        if (fromHold) {
          await supabase.from("tasks").update({ on_hold: false }).eq("id", activeId);
        }
        const { error } = await supabase.from("task_followups").upsert(
          {
            task_id: activeId,
            workspace_id: wsId,
            created_by: userId,
            waiting_user_id: null,
            waiting_contact_id: null,
          },
          { onConflict: "task_id", ignoreDuplicates: true }
        );
        if (error) toast("Přesun do Waiting on se nezdařil.", "error");
        else toast("Karta čeká — na kartě můžeš doplnit, na koho.");
      }
      load();
      return;
    }
    if (dropTarget === HOLD_COL) {
      if (fromBoard || fromWaiting) {
        moveLocally(activeId, HOLD_COL, { on_hold: true });
        const { error } = await supabase
          .from("tasks")
          .update({ on_hold: true })
          .eq("id", activeId);
        if (error) toast("Uspání karty se nezdařilo.", "error");
      }
      load();
      return;
    }
    if (dropTarget === DONE_COL) {
      if (fromBoard || fromHold || fromWaiting) {
        const completed_at = new Date().toISOString();
        moveLocally(activeId, DONE_COL, { completed_at, on_hold: false });
        const { error } = await supabase
          .from("tasks")
          .update(fromHold ? { completed_at, on_hold: false } : { completed_at })
          .eq("id", activeId);
        if (error) toast("Dokončení se nezdařilo.", "error");
        else pingNotifyEmails(); // opakovaná karta může přiřadit další výskyt
      }
      load();
      return;
    }
    // z automatického sloupce zpět do běžného: probuzení / zrušení čekání
    if ((fromHold || fromWaiting) && dropTarget && !dropTarget.startsWith("__")) {
      const list = cards[dropTarget] ?? [];
      const position = posBetween(list[list.length - 1]?.position, undefined);
      moveLocally(activeId, dropTarget, {
        on_hold: false,
        column_id: dropTarget,
        position,
      });
      if (fromWaiting) {
        await supabase.from("task_followups").delete().eq("task_id", activeId);
      }
      const { error } = await supabase
        .from("tasks")
        .update(
          fromHold
            ? { on_hold: false, column_id: dropTarget, position }
            : { column_id: dropTarget, position }
        )
        .eq("id", activeId);
      if (error) toast("Přesun karty se nezdařil.", "error");
      load();
      return;
    }

    // dokončení přesunu karty
    const colId = findColumnOf(activeId);
    if (!colId) return;
    let list = cards[colId];
    const oldIndex = list.findIndex((t) => t.id === activeId);
    const overIndex = list.findIndex((t) => t.id === overId);
    if (overIndex >= 0 && oldIndex !== overIndex) {
      list = arrayMove(list, oldIndex, overIndex);
    }
    const newIndex = list.findIndex((t) => t.id === activeId);
    const position = posBetween(
      list[newIndex - 1]?.position,
      list[newIndex + 1]?.position
    );
    const updated = list.map((t) =>
      t.id === activeId ? { ...t, position, column_id: colId } : t
    );
    discardLoads();
    setCards((prev) => ({ ...prev, [colId]: updated }));
    const { error } = await supabase
      .from("tasks")
      .update({ column_id: colId, position })
      .eq("id", activeId);
    if (error) {
      toast("Přesun karty se neuložil — obnovuji nástěnku.", "error");
      load();
    } else if (reloadAfterMove.current) load(); // zahozené načtení dohnat
  }

  if (loading) return <BoardSkeleton />;
  // chyba a nic dřív načteného: prázdná nástěnka by lhala (a sváděla
  // k založení „prvního" sloupce znovu) — hláška místo ní
  if (
    loadError &&
    columns.length === 0 &&
    orphans.length === 0 &&
    holdTasks.length === 0 &&
    waitingTasks.length === 0 &&
    doneTasks.length === 0
  )
    return <LoadError onRetry={load} message="Nástěnku se nepodařilo načíst." />;

  const filterActive =
    fText.trim() !== "" || fPriority !== 0 || fLabel !== "" || fAssignee !== "";
  const visible = (list: Task[]): Task[] => {
    if (!filterActive) return list;
    const q = fText.trim().toLowerCase();
    return list.filter(
      (t) =>
        (!q ||
          t.title.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q)) &&
        (fPriority === 0 || (t.priority ?? 4) === fPriority) &&
        (!fLabel || (cardLabels[t.id] ?? []).some((l) => l.id === fLabel)) &&
        (!fAssignee || (cardAssignees[t.id] ?? []).includes(fAssignee))
    );
  };

  return (
    // flex sloupec přes celou výšku — vodorovný scrollbar nástěnky tak
    // sedí u spodní hrany displeje, ne hned pod sloupci
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="flex items-center gap-2.5 font-display text-lg font-semibold">
          <ProjectDot id={projectId} className="h-3 w-3" />
          {projectName}
        </h1>
        <span className="flex-1" />
        <input
          type="search"
          placeholder="Hledat na nástěnce…"
          value={fText}
          onChange={(e) => setFText(e.target.value)}
          className="input w-44 px-2 py-1 text-sm"
        />
        <select
          value={fPriority}
          onChange={(e) => setFPriority(Number(e.target.value))}
          aria-label="Filtr priority"
          className="input px-2 py-1 text-sm"
        >
          <option value={0}>Priorita: vše</option>
          {PRIORITIES.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        {wsLabels.length > 0 && (
          <select
            value={fLabel}
            onChange={(e) => setFLabel(e.target.value)}
            aria-label="Filtr štítku"
            className="input px-2 py-1 text-sm"
          >
            <option value="">Štítek: vše</option>
            {wsLabels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        )}
        <select
          value={fAssignee}
          onChange={(e) => setFAssignee(e.target.value)}
          aria-label="Filtr řešitele"
          className="input px-2 py-1 text-sm"
        >
          <option value="">Řešitel: všichni</option>
          {members.map((m) => (
            <option key={m.user_id} value={m.user_id}>
              {m.profiles?.full_name || m.profiles?.email}
            </option>
          ))}
        </select>
        {filterActive && (
          <button
            onClick={() => {
              setFText("");
              setFPriority(0);
              setFLabel("");
              setFAssignee("");
            }}
            className="btn-ghost px-2 py-1 text-xs"
          >
            Zrušit filtry
          </button>
        )}
      </div>

      {loadError && (
        <LoadError onRetry={load} message="Nástěnku se nepodařilo obnovit." stale />
      )}

      {orphans.length > 0 && (
        <div className="panel space-y-2 border-amber-300 bg-amber-50 p-3">
          <p className="text-sm text-amber-900">
            Tyto karty nemají sloupec. Založ sloupec a karty do něj přesuň
            přetažením, nebo je otevři a uprav.
          </p>
          <div className="flex flex-wrap gap-2">
            {orphans.map((task) => (
              <button
                key={task.id}
                onClick={() => setOpenTask(task)}
                className="rounded-lg border border-amber-300 bg-surface px-2 py-1 text-sm hover:border-accent/60"
              >
                {task.title}
              </button>
            ))}
          </div>
        </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="flex min-h-0 flex-1 items-start gap-3 overflow-x-auto scroll-touch snap-x snap-proximity pb-1">
          <SortableContext
            items={columns.map((c) => colDndId(c.id))}
            strategy={horizontalListSortingStrategy}
          >
            {columns.map((col) => (
              <SortableColumn
                key={col.id}
                column={col}
                cardCount={visible(cards[col.id] ?? []).length}
                isEditing={editingCol === col.id}
                editName={editColName}
                onEditName={setEditColName}
                onStartRename={() => startRenameColumn(col)}
                onSaveRename={() => saveRenameColumn(col)}
                onDelete={() => deleteColumn(col)}
              >
                <SortableContext
                  items={visible(cards[col.id] ?? []).map((t) => t.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="flex min-h-2 flex-col gap-2">
                    {visible(cards[col.id] ?? []).map((task) => (
                      <BoardCard
                        key={task.id}
                        task={task}
                        members={members}
                        labels={cardLabels[task.id]}
                        assigneeIds={cardAssignees[task.id]}
                        subtaskCount={subCounts[task.id]}
                        waitingOn={cardWaiting[task.id]}
                        ghostAssignees={cardGhosts[task.id]}
                        onOpen={openCard}
                        onStart={startCard}
                      />
                    ))}
                  </div>
                </SortableContext>

                {addingTo === col.id ? (
                  <form onSubmit={(e) => addCard(col.id, e)} className="mt-2 flex gap-1">
                    <input
                      autoFocus
                      type="text"
                      placeholder="Název karty…"
                      value={newCardTitle}
                      onChange={(e) => setNewCardTitle(e.target.value)}
                      onBlur={() => !newCardTitle.trim() && setAddingTo(null)}
                      className="w-full input px-2"
                    />
                    <button type="submit" className="btn-primary px-2">
                      OK
                    </button>
                  </form>
                ) : (
                  <button
                    onClick={() => {
                      setAddingTo(col.id);
                      setNewCardTitle("");
                    }}
                    className="mt-2 w-full rounded-md px-2 py-1 text-left text-xs text-ink-soft/70 hover:bg-black/10 hover:text-ink-soft"
                  >
                    + Přidat kartu
                  </button>
                )}
              </SortableColumn>
            ))}
          </SortableContext>

          {/* automatické sloupce — má je každý projekt, plní se samy */}
          <VirtualColumn
            dndId={colDndId(WAITING_COL)}
            title="⏳ Waiting on"
            count={visible(waitingTasks).length}
            hint="Karty s follow-upem („Čekám na“). Přetažením sem karta začne čekat (na koho doplníš na kartě), přetažením ven čekání zrušíš."
          >
            <SortableContext
              items={visible(waitingTasks).map((t) => t.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="flex min-h-2 flex-col gap-2">
                {visible(waitingTasks).map((task) => (
                  <BoardCard
                    key={task.id}
                    task={task}
                    members={members}
                    labels={cardLabels[task.id]}
                    assigneeIds={cardAssignees[task.id]}
                    subtaskCount={subCounts[task.id]}
                    waitingOn={cardWaiting[task.id]}
                    ghostAssignees={cardGhosts[task.id]}
                    onOpen={openCard}
                    onStart={startCard}
                  />
                ))}
              </div>
            </SortableContext>
          </VirtualColumn>
          <VirtualColumn
            dndId={colDndId(HOLD_COL)}
            title="💤 Hold"
            count={visible(holdTasks).length}
            hint="Uspané karty — vidět jen tady na nástěnce, ne v Task force ani v Moje úkoly. Přetažením sem kartu uspíš, přetažením ven probudíš."
          >
            <SortableContext
              items={visible(holdTasks).map((t) => t.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="flex min-h-2 flex-col gap-2">
                {visible(holdTasks).map((task) => (
                  <BoardCard
                    key={task.id}
                    task={task}
                    members={members}
                    labels={cardLabels[task.id]}
                    assigneeIds={cardAssignees[task.id]}
                    subtaskCount={subCounts[task.id]}
                    waitingOn={cardWaiting[task.id]}
                    ghostAssignees={cardGhosts[task.id]}
                    onOpen={openCard}
                    onStart={startCard}
                  />
                ))}
              </div>
            </SortableContext>
          </VirtualColumn>
          <VirtualColumn
            dndId={colDndId(DONE_COL)}
            title="✓ Done"
            count={visible(doneTasks).length}
            hint="Plní se automaticky dokončenými kartami; přetažením sem kartu dokončíš."
          >
            <SortableContext
              items={visible(doneTasks).map((t) => t.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="flex min-h-2 flex-col gap-2">
                {visible(doneTasks).map((task) => (
                  <BoardCard
                    key={task.id}
                    task={task}
                    members={members}
                    labels={cardLabels[task.id]}
                    assigneeIds={cardAssignees[task.id]}
                    subtaskCount={subCounts[task.id]}
                    waitingOn={cardWaiting[task.id]}
                    ghostAssignees={cardGhosts[task.id]}
                    onOpen={openCard}
                    onStart={startCard}
                  />
                ))}
                {doneMore && (
                  <button
                    type="button"
                    onClick={() => setDoneLimit((n) => n + DONE_PAGE)}
                    className="rounded-md px-2 py-1.5 text-xs text-ink-soft hover:bg-black/5"
                  >
                    Načíst starší hotové…
                  </button>
                )}
              </div>
            </SortableContext>
          </VirtualColumn>

          <form onSubmit={addColumn} className="w-64 shrink-0">
            <input
              type="text"
              placeholder={
                columns.length === 0
                  ? "Začni prvním sloupcem, např. „K udělání“…"
                  : "+ Nový sloupec…"
              }
              value={newColumnName}
              onChange={(e) => setNewColumnName(e.target.value)}
              className="w-full rounded-lg border border-dashed border-line bg-transparent px-3 py-2 text-sm placeholder:text-ink-soft/70"
            />
          </form>
        </div>

        <DragOverlay>
          {activeCard && (
            <div className="rounded-lg border border-line bg-surface p-2 shadow-lg">
              <p className="text-sm">{activeCard.title}</p>
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {openTask && (
        <CardModal
          task={openTask}
          members={members}
          userId={userId}
          onClose={() => setOpenTask(null)}
          onChanged={() => {
            setOpenTask(null);
            load();
          }}
        />
      )}
    </div>
  );
}

/** Automatický sloupec (Waiting on / Done): nejde přejmenovat, smazat ani
    přesouvat a nemá „+ Přidat kartu" — plní se sám. Je ale droppable,
    aby šla karta přetažením do Done rovnou dokončit. */
function VirtualColumn({
  dndId,
  title,
  count,
  hint,
  children,
}: {
  dndId: string;
  title: string;
  count: number;
  hint: string;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: dndId });
  return (
    <div
      ref={setNodeRef}
      className={`w-64 shrink-0 snap-start rounded-xl bg-black/5 p-2 ${
        isOver ? "ring-2 ring-accent/40" : ""
      }`}
    >
      <div className="mb-2 flex items-center gap-1 px-1" title={hint}>
        <span className="flex-1 truncate text-sm font-semibold text-ink-soft">
          {title}
          <span className="ml-1.5 text-xs font-normal text-ink-soft/70">
            {count}
          </span>
        </span>
        <span className="text-xs text-ink-soft/40" aria-hidden>
          auto
        </span>
      </div>
      {children}
    </div>
  );
}

function SortableColumn({
  column,
  cardCount,
  isEditing,
  editName,
  onEditName,
  onStartRename,
  onSaveRename,
  onDelete,
  children,
}: {
  column: BoardColumn;
  cardCount: number;
  isEditing: boolean;
  editName: string;
  onEditName: (v: string) => void;
  onStartRename: () => void;
  onSaveRename: () => void;
  onDelete: () => void;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: colDndId(column.id), data: { type: "column" } });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`w-64 shrink-0 snap-start rounded-xl bg-black/5 p-2 ${isDragging ? "opacity-50" : ""}`}
    >
      <div className="mb-2 flex items-center gap-1">
        <button
          {...attributes}
          {...listeners}
          aria-label={`Přetáhnout sloupec ${column.name}`}
          className="cursor-grab rounded px-1 text-ink-soft/70 hover:bg-black/10"
        >
          ⠿
        </button>
        {isEditing ? (
          <form
            className="flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              onSaveRename();
            }}
          >
            <input
              autoFocus
              type="text"
              value={editName}
              onChange={(e) => onEditName(e.target.value)}
              onBlur={onSaveRename}
              className="w-full input px-1 py-0.5 text-sm"
            />
          </form>
        ) : (
          <button
            onClick={onStartRename}
            className="flex-1 truncate rounded px-1 text-left text-sm font-semibold hover:bg-black/5"
            title="Kliknutím přejmenuješ"
          >
            {column.name}
            <span className="ml-1.5 text-xs font-normal text-ink-soft/70">
              {cardCount}
            </span>
          </button>
        )}
        <button
          onClick={onDelete}
          aria-label={`Smazat sloupec ${column.name}`}
          className="rounded px-1 text-xs text-ink-soft/70 hover:bg-black/10"
        >
          ×
        </button>
      </div>
      {children}
    </div>
  );
}
