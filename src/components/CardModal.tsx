"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { startTimer } from "@/lib/timer";
import { toast } from "@/lib/toast";
import { confirmDialog } from "@/lib/confirm";
import { pingNotifyEmails } from "@/lib/notify";
import { notifyTasksChanged } from "@/lib/tasksChanged";
import { syncTaskCalendar } from "@/app/actions/calendar";
import { PRIORITIES, RECURRENCE_OPTIONS, priorityColor } from "@/lib/priority";
import ProjectPicker, { projectColor } from "@/components/ProjectPicker";
import PersonPicker, {
  HOURGLASS_ICON,
  isMemberRef,
  personRefId,
} from "@/components/PersonPicker";
import Avatar from "@/components/Avatar";
import CardAttachments from "@/components/CardAttachments";
import CardChecklists from "@/components/CardChecklists";
import type {
  Contact,
  Label,
  Membership,
  Project,
  Recurrence,
  Task,
  TaskActivity,
  TaskComment,
  TaskFollowup,
} from "@/lib/types";

/** Věta aktivity v češtině podle typu události. */
function activityText(a: TaskActivity): string {
  const m = a.meta ?? {};
  const to = m.to as string | number | null | undefined;
  switch (a.kind) {
    case "created":
      return "vytvořil/a kartu";
    case "moved_column":
      return `přesunul/a kartu do sloupce „${to ?? "?"}"`;
    case "moved_project":
      return `přesunul/a kartu do projektu „${to ?? "?"}"`;
    case "due_changed":
      return to ? `nastavil/a termín na ${to}` : "zrušil/a termín";
    case "priority_changed":
      return `změnil/a prioritu na P${to}`;
    case "completed":
      return "dokončil/a kartu";
    case "reopened":
      return "znovu otevřel/a kartu";
    case "assigned":
      return `přiřadil/a ${(m.user as string) ?? "kolegu"}`;
    case "unassigned":
      return `odebral/a ${(m.user as string) ?? "kolegu"}`;
    case "followup_set":
      return `nastavil/a čekání na ${(m.who as string) ?? "?"}`;
    case "followup_cleared":
      return `zrušil/a čekání na ${(m.who as string) ?? "?"}`;
    case "lead_changed":
      return to ? `nastavil/a vedoucího ${to}` : "zrušil/a vedoucího";
    default:
      return "upravil/a kartu";
  }
}

function localDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function localTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Textarea názvu roste s obsahem (1–3 řádky), místo useknutého inputu. */
function autoGrow(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

function fmtStamp(iso: string): string {
  return new Date(iso).toLocaleString("cs-CZ", {
    day: "numeric",
    month: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** @tagy zvýrazní akcentem, URL udělá klikací; dlouhé odkazy zalamuje,
    aby nepřetékaly z bubliny. */
function CommentBody({ body }: { body: string }) {
  const parts = body.split(/(@[a-z0-9_.]{2,30}|https?:\/\/[^\s<>"')]+)/gi);
  return (
    <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">
      {parts.map((part, i) =>
        /^@[a-z0-9_.]{2,30}$/i.test(part) ? (
          <span key={i} className="font-medium text-accent">
            {part}
          </span>
        ) : /^https?:\/\//i.test(part) ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-accent underline decoration-accent/40 hover:decoration-accent"
          >
            {part}
          </a>
        ) : (
          part
        )
      )}
    </p>
  );
}

export default function CardModal({
  task,
  members,
  userId,
  onClose,
  onChanged,
}: {
  task: Task;
  members: Membership[];
  userId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const supabase = createClient();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const descriptionLinks = useMemo(
    () => Array.from(new Set(description.match(/https?:\/\/[^\s<>"')]+/g) ?? [])),
    [description]
  );
  const [projectId, setProjectId] = useState(task.project_id);
  const [projects, setProjects] = useState<Project[]>([]);
  const [assignees, setAssignees] = useState<Set<string>>(new Set());
  const [ghostAssignees, setGhostAssignees] = useState<Set<string>>(new Set());
  const [leadId, setLeadId] = useState<string | null>(task.lead_id ?? null);
  const [projectMembers, setProjectMembers] = useState<Set<string>>(new Set());
  const [grants, setGrants] = useState<Set<string>>(new Set());
  const [dueDate, setDueDate] = useState(task.due_date ?? "");
  const [priority, setPriority] = useState(task.priority ?? 4);
  const [recurrence, setRecurrence] = useState<string>(task.recurrence ?? "");
  const [done, setDone] = useState(!!task.completed_at);
  const [isPrivate, setIsPrivate] = useState(!!task.is_private);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [activity, setActivity] = useState<TaskActivity[]>([]);
  const [newComment, setNewComment] = useState("");
  const [sending, setSending] = useState(false); // odesílání komentáře
  const [labels, setLabels] = useState<Label[]>([]);
  const [taskLabels, setTaskLabels] = useState<Set<string>>(new Set());
  const [newLabel, setNewLabel] = useState("");
  const [addingLabel, setAddingLabel] = useState(false);
  const [subtasks, setSubtasks] = useState<Task[]>([]);
  const [newSubtask, setNewSubtask] = useState("");
  // plánované okno práce → kalendář „Kronos" řešitelů (datum + od–do)
  const [planDate, setPlanDate] = useState(() =>
    task.planned_start ? localDate(task.planned_start) : ""
  );
  const [planFrom, setPlanFrom] = useState(() =>
    task.planned_start ? localTime(task.planned_start) : ""
  );
  const [planTo, setPlanTo] = useState(() =>
    task.planned_end ? localTime(task.planned_end) : ""
  );
  // follow-up „čekám na" — člen nebo externí kontakt (viz CONCEPT-delegovane.md)
  const [followup, setFollowup] = useState<TaskFollowup | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [error, setError] = useState<string | null>(null);
  // autosave: pole se ukládají samy (text při opuštění, výběry hned)
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  // co je v DB (mění se až po úspěšném zápisu) — ať se text neukládá
  // zbytečně a neuložený se při dalším pokusu (zavření karty) zkusí znovu
  const savedRef = useRef({ title: task.title, description: task.description });
  // výběry (termín, priorita, opakování, skrytý): hodnota v DB a pořadí
  // posledního zápisu — při chybě se pole vrátí na uloženou hodnotu
  const savedChoices = useRef<Record<string, unknown>>({
    due_date: task.due_date ?? "",
    priority: task.priority ?? 4,
    recurrence: task.recurrence ?? "",
    is_private: !!task.is_private,
  });
  const choiceSeq = useRef<Record<string, number>>({});
  // zápisy karty jdou za sebou: pořadí v DB = pořadí úprav a zavření karty
  // počká, až doběhnou
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  // něco se ukládalo → při zavření musí parent přenačíst seznam
  const changedRef = useRef(false);
  const closeRef = useRef<() => void>(() => {});
  const closingRef = useRef(false); // zavírání čeká na uložení — neopakovat
  const addingSubtask = useRef(false); // druhý Enter nesmí založit podúkol znovu
  // debounce autosave popisu — ukládá se během psaní, ne až při opuštění pole
  const descTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // našeptávač @zmínek v komentáři
  const commentRef = useRef<HTMLInputElement>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionActive, setMentionActive] = useState(0);
  // mobil: karta má záložky Úkol / Komentáře (na desktopu oba sloupce vedle sebe)
  const [mobileTab, setMobileTab] = useState<"task" | "comments">("task");
  // počet komentářů naposledy viděných v záložce Komentáře → tečka u nových
  const [seenComments, setSeenComments] = useState<number | null>(null);

  useEffect(() => {
    dialogRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      // Esc spotřebovaný vnořeným prvkem (nabídka pickeru, našeptávač
      // zmínek, potvrzovací dialog) kartu nezavírá
      if (e.key === "Escape" && !e.defaultPrevented) closeRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // popis se ukládá sám ~1 s po posledním úhozu (i bez opuštění pole)
  useEffect(() => {
    if (description === savedRef.current.description) return;
    if (descTimer.current) clearTimeout(descTimer.current);
    descTimer.current = setTimeout(() => {
      saveText("description", description);
    }, 1000);
    return () => {
      if (descTimer.current) clearTimeout(descTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [description]);

  const loadComments = useCallback(async () => {
    const { data } = await supabase
      .from("task_comments")
      .select("*, profiles(full_name, email, avatar_initials, avatar_color)")
      .eq("task_id", task.id)
      .order("created_at");
    const list = (data as TaskComment[]) ?? [];
    setComments(list);
    setSeenComments((seen) => seen ?? list.length); // první načtení = viděno
  }, [supabase, task.id]);

  const loadActivity = useCallback(async () => {
    const { data, error } = await supabase
      .from("task_activity")
      .select("*, profiles(full_name, email)")
      .eq("task_id", task.id)
      .order("created_at");
    if (error) return; // tabulka nemusí existovat před migrací
    setActivity((data as TaskActivity[]) ?? []);
  }, [supabase, task.id]);

  const loadLabels = useCallback(async () => {
    const [allRes, mineRes] = await Promise.all([
      supabase
        .from("labels")
        .select("*")
        .eq("workspace_id", task.workspace_id)
        .order("name"),
      supabase.from("task_labels").select("label_id").eq("task_id", task.id),
    ]);
    setLabels((allRes.data as Label[]) ?? []);
    setTaskLabels(new Set((mineRes.data ?? []).map((r) => r.label_id as string)));
  }, [supabase, task.workspace_id, task.id]);

  const loadSubtasks = useCallback(async () => {
    const { data } = await supabase
      .from("tasks")
      .select("*")
      .eq("parent_id", task.id)
      .order("created_at");
    setSubtasks((data as Task[]) ?? []);
  }, [supabase, task.id]);

  const loadFollowup = useCallback(async () => {
    const [fuRes, cRes] = await Promise.all([
      supabase
        .from("task_followups")
        .select("*, contacts(name)")
        .eq("task_id", task.id)
        .maybeSingle(),
      supabase
        .from("contacts")
        .select("*")
        .eq("workspace_id", task.workspace_id)
        .order("name"),
    ]);
    if (!fuRes.error) setFollowup((fuRes.data as TaskFollowup) ?? null);
    setContacts((cRes.data as Contact[]) ?? []);
  }, [supabase, task.id, task.workspace_id]);

  const loadProjects = useCallback(async () => {
    const { data } = await supabase
      .from("projects")
      .select("id, name")
      .eq("workspace_id", task.workspace_id)
      .eq("archived", false)
      .order("position")
      .order("name");
    setProjects((data as Project[]) ?? []);
  }, [supabase, task.workspace_id]);

  const loadAssignees = useCallback(async () => {
    const [mineRes, ghostRes, pmRes, grantRes] = await Promise.all([
      supabase.from("task_assignees").select("user_id").eq("task_id", task.id),
      supabase
        .from("task_contact_assignees")
        .select("contact_id")
        .eq("task_id", task.id),
      task.project_id
        ? supabase
            .from("project_members")
            .select("user_id")
            .eq("project_id", task.project_id)
        : Promise.resolve({ data: [] as { user_id: string }[] }),
      supabase
        .from("assign_grants")
        .select("target_id")
        .eq("workspace_id", task.workspace_id)
        .eq("user_id", userId),
    ]);
    setAssignees(new Set((mineRes.data ?? []).map((r) => r.user_id as string)));
    if (!ghostRes.error)
      setGhostAssignees(
        new Set((ghostRes.data ?? []).map((r) => r.contact_id as string))
      );
    setProjectMembers(new Set((pmRes.data ?? []).map((r) => r.user_id as string)));
    setGrants(new Set((grantRes.data ?? []).map((r) => r.target_id as string)));
  }, [supabase, task.id, task.project_id, task.workspace_id, userId]);

  useEffect(() => {
    loadComments();
    loadActivity();
    loadLabels();
    loadSubtasks();
    loadAssignees();
    loadProjects();
    loadFollowup();
  }, [
    loadComments,
    loadActivity,
    loadLabels,
    loadSubtasks,
    loadAssignees,
    loadProjects,
    loadFollowup,
  ]);

  // kdo smí měnit čí přiřazení: admin komukoli, člen sobě + s grantem
  const me = members.find((m) => m.user_id === userId);
  const isAdmin = !!(me?.profiles?.is_super_admin || me?.role === "admin");
  const canManage = (id: string) => isAdmin || id === userId || grants.has(id);

  // delegace („Čekám na") je odemknutá adminům a členům s can_delegate
  const canDelegate = isAdmin || !!me?.can_delegate;
  // skryté úkoly smí přepínat jen autor s odemknutou funkcí (adminům vždy)
  const canTogglePrivate =
    task.created_by === userId && (isAdmin || !!me?.can_hide);

  // admin smí přiřadit kohokoli z firmy (nečlena projektu na projekt doplníme
  // při přiřazení, jinak by úkol neviděl); člen vybírá jen z členů projektu.
  // Úkol bez projektu: kdokoli z firmy. Skrytý úkol vidí autor + řešitelé.
  const assignable =
    isAdmin || !task.project_id
      ? members
      : members.filter((m) => projectMembers.has(m.user_id) || m.role === "admin");

  // jeden řešitel: první člen, jinak první duch, jinak nikdo
  const currentMemberId = [...assignees][0] ?? null;
  const currentGhostId = [...ghostAssignees][0] ?? null;
  const currentAssigneeRef = currentMemberId
    ? `u:${currentMemberId}`
    : currentGhostId
      ? `c:${currentGhostId}`
      : null;
  // cizí přiřazeného člena smí měnit jen kdo ho spravuje; ducha / prázdno kdokoli
  const canEditAssignee = currentMemberId ? canManage(currentMemberId) : true;

  // Jeden řešitel: nastavení nahradí případného předchozího (člena i ducha).
  // ref: "u:<userId>" (člen) | "c:<contactId>" (duch) | null (nikdo).
  async function setSingleAssignee(ref: string | null) {
    const memberId = ref && isMemberRef(ref) ? personRefId(ref) : null;
    const ghostId = ref && !isMemberRef(ref) ? personRefId(ref) : null;
    // chyba uprostřed: část změny už mohla projít — kartu i seznamy srovnat
    // podle DB, ať neukazují řešitele, který tam není
    const fail = (message: string) => {
      toast(message, "error");
      loadAssignees();
      notifyTasksChanged();
    };

    // optimisticky přepni na jednoho (ostatní zmizí)
    setAssignees(memberId ? new Set([memberId]) : new Set());
    setGhostAssignees(ghostId ? new Set([ghostId]) : new Set());

    // řešitel musí být člen projektu, jinak by úkol kvůli RLS neviděl.
    // Admin proto nečlena při přiřazení rovnou doplní na projekt — ještě
    // před smazáním starého přiřazení, ať chyba tady nenechá úkol bez řešitele.
    if (memberId && task.project_id && isAdmin && !projectMembers.has(memberId)) {
      const { error: pmError } = await supabase
        .from("project_members")
        .upsert(
          { project_id: task.project_id, user_id: memberId },
          { onConflict: "project_id,user_id", ignoreDuplicates: true }
        );
      if (pmError) {
        fail("Nepodařilo se přidat uživatele na projekt.");
        return;
      }
      setProjectMembers((prev) => new Set(prev).add(memberId));
    }

    // smaž veškeré stávající přiřazení (členy i duchy)
    for (const table of ["task_assignees", "task_contact_assignees"]) {
      const { error } = await supabase.from(table).delete().eq("task_id", task.id);
      if (error) {
        fail("Změna řešitele se nezdařila.");
        return;
      }
    }

    if (memberId) {
      const { error } = await supabase
        .from("task_assignees")
        .insert({ task_id: task.id, user_id: memberId });
      if (error) {
        fail("Změna řešitele se nezdařila.");
        return;
      }
      pingNotifyEmails();
    } else if (ghostId) {
      const { error } = await supabase
        .from("task_contact_assignees")
        .insert({ task_id: task.id, contact_id: ghostId });
      if (error) {
        fail("Změna řešitele se nezdařila.");
        return;
      }
    }
    loadActivity();
    notifyTasksChanged(); // úkol se přesouvá v „Moje úkoly" nového řešitele
  }

  // Vedoucí úkolu (jen admin) — interní člen, který má na starost splnění.
  async function setLead(ref: string | null) {
    const memberId = ref && isMemberRef(ref) ? personRefId(ref) : null;
    const prev = leadId;
    setLeadId(memberId);
    const { error } = await supabase
      .from("tasks")
      .update({ lead_id: memberId })
      .eq("id", task.id);
    if (error) {
      toast("Změna vedoucího se nezdařila.", "error");
      setLeadId(prev);
      return;
    }
    loadActivity();
  }

  // ---------------------------------------------------------------- follow-up

  /** value: "u:<userId>" (člen) nebo "c:<contactId>" (kontakt). */
  async function startWaiting(value: string) {
    if (!value) return;
    const id = value.slice(2);
    const { error } = await supabase.from("task_followups").insert({
      task_id: task.id,
      workspace_id: task.workspace_id,
      created_by: userId,
      waiting_user_id: value.startsWith("u:") ? id : null,
      waiting_contact_id: value.startsWith("c:") ? id : null,
    });
    if (error) {
      toast("Čekání se nepodařilo nastavit.", "error");
      return;
    }
    loadFollowup();
    loadActivity();
    notifyTasksChanged(); // úkol se přesouvá z Moje úkoly na stránku Čekám na
  }

  async function stopWaiting() {
    const { error } = await supabase
      .from("task_followups")
      .delete()
      .eq("task_id", task.id);
    if (error) {
      toast("Zrušení čekání se nezdařilo.", "error");
      return;
    }
    loadFollowup();
    loadActivity();
    notifyTasksChanged();
  }

  /** Doplnění osoby k čekání bez osoby. */
  async function assignWaiting(value: string) {
    if (!value) return;
    const id = value.slice(2);
    const { error } = await supabase
      .from("task_followups")
      .update({
        waiting_user_id: value.startsWith("u:") ? id : null,
        waiting_contact_id: value.startsWith("c:") ? id : null,
      })
      .eq("task_id", task.id);
    if (error) {
      toast("Změna se nezdařila.", "error");
      return;
    }
    loadFollowup();
    loadActivity();
  }

  /** Úprava dat čekání — od kdy / do kdy (slíbený termín dodání). */
  async function patchFollowup(patch: {
    waiting_since?: string;
    waiting_until?: string | null;
  }) {
    const { error } = await supabase
      .from("task_followups")
      .update(patch)
      .eq("task_id", task.id);
    if (error) {
      toast("Uložení termínu se nezdařilo.", "error");
      return;
    }
    loadFollowup();
  }

  /** Nový duch z „➕ založit" v PersonPickeru — jen doplnit do seznamu. */
  function addContact(contact: Contact) {
    setContacts((prev) =>
      [...prev, contact].sort((a, b) => a.name.localeCompare(b.name, "cs"))
    );
  }

  /** „➕ založit projekt" z pickeru v hlavičce (jen admin — RLS). */
  async function createProjectAndSelect(name: string) {
    const { data, error } = await supabase
      .from("projects")
      .insert({ workspace_id: task.workspace_id, name })
      .select("id")
      .single();
    if (error || !data) {
      toast("Projekt se nepodařilo založit.", "error");
      return;
    }
    await loadProjects();
    await saveProject(data.id as string);
  }

  /** Jeden zápis do karty. Změna se počítá hned (i rozběhnutá či neúspěšná)
      — seznam pod kartou se pak při zavření přenačte. */
  async function writeTask(patch: Record<string, unknown>) {
    changedRef.current = true;
    setSaveState("saving");
    // zaseklé spojení (probuzení z uspání) nesmí zavření karty držet donekonečna
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 15_000);
    const { error } = await supabase
      .from("tasks")
      .update(patch)
      .eq("id", task.id)
      .abortSignal(abort.signal);
    clearTimeout(timeout);
    if (error) {
      setSaveState("idle");
      setError("Uložení se nezdařilo.");
      toast("Změnu se nepodařilo uložit.", "error");
      return false;
    }
    setError(null);
    setSaveState("saved");
    loadActivity();
    return true;
  }

  /** Zařadí zápis za předchozí (spustí se i po jejich chybě). */
  function enqueue(job: () => Promise<boolean>) {
    const run = saveQueue.current.then(job, job);
    saveQueue.current = run;
    return run;
  }

  /** Uloží dílčí změnu rovnou do DB (autosave) — modal zůstává otevřený. */
  function autosave(patch: Record<string, unknown>) {
    return enqueue(() => writeTask(patch));
  }

  /** Název/popis zapíše, jen když se liší od DB — porovná se až na řadě
      ve frontě, po doběhnutí předchozích zápisů. */
  function saveText(field: "title" | "description", value: string) {
    return enqueue(async () => {
      if (value === savedRef.current[field]) return true;
      const ok = await writeTask({ [field]: value });
      if (ok) savedRef.current[field] = value;
      return ok;
    });
  }

  /** Text se ukládá při opuštění pole a jen když se opravdu změnil. */
  function saveTitle() {
    const next = title.trim() || task.title;
    if (next !== title) setTitle(next);
    return saveText("title", next);
  }

  function saveDescription() {
    if (descTimer.current) clearTimeout(descTimer.current);
    return saveText("description", description);
  }

  /** Výběr (termín, priorita, opakování, skrytý) se ukládá hned. Když zápis
      selže, pole se vrátí na hodnotu v DB — jen u poslední volby; o novější
      (čeká ve frontě) rozhodne její vlastní zápis. */
  async function saveChoice<T>(
    column: string,
    next: T,
    set: React.Dispatch<React.SetStateAction<T>>,
    dbValue: unknown = next
  ) {
    set(next);
    const seq = (choiceSeq.current[column] ?? 0) + 1;
    choiceSeq.current[column] = seq;
    if (await autosave({ [column]: dbValue })) savedChoices.current[column] = next;
    else if (seq === choiceSeq.current[column])
      set(savedChoices.current[column] as T);
  }

  /** Přesun karty do jiného projektu — s ním putují i podúkoly. */
  async function saveProject(next: string | null) {
    setProjectId(next);
    // cílový projekt má vlastní sloupce → kartu vyřadíme ze sloupce, board ji
    // při načtení zařadí do prvního sloupce nového projektu
    const ok = await autosave({ project_id: next, column_id: null });
    if (!ok) {
      setProjectId(projectId);
      return;
    }
    // podúkoly patří k rodiči — přesuň je do stejného projektu
    await supabase.from("tasks").update({ project_id: next }).eq("parent_id", task.id);
  }

  async function saveDone(next: boolean) {
    setDone(next);
    const ok = await autosave({
      completed_at: next ? (task.completed_at ?? new Date().toISOString()) : null,
    });
    if (!ok) {
      setDone(!next);
      return;
    }
    pingNotifyEmails(); // dokončení opakované karty přiřazuje další výskyt
  }

  /** Plánované okno: uloží se, až jsou vyplněné datum i oba časy; pak se
      propíše do kalendáře „Kronos" řešitelů. */
  async function savePlan(date: string, from: string, to: string) {
    if (!date || !from || !to) return;
    if (to <= from) {
      setError("Konec plánu musí být po začátku.");
      return;
    }
    const start = new Date(`${date}T${from}`).toISOString();
    const end = new Date(`${date}T${to}`).toISOString();
    const ok = await autosave({ planned_start: start, planned_end: end });
    if (!ok) return;
    const res = await syncCalendar();
    if (!res) return;
    if (res.error) toast(res.error, "error");
    else if ((res.synced ?? 0) === 0 && (res.skipped ?? 0) > 0)
      toast("Plán uložen; kalendář se nezaložil — účet mimo Workspace.", "error");
    else toast("Plán uložen do kalendáře.");
  }

  async function clearPlan() {
    setPlanDate("");
    setPlanFrom("");
    setPlanTo("");
    const ok = await autosave({ planned_start: null, planned_end: null });
    if (!ok) return;
    const res = await syncCalendar();
    if (res?.error) toast(res.error, "error");
  }

  /** Server action po nasazení nové verze v otevřené záložce selže (staré
      id akce) — musí skončit hláškou, ne nezachyceným rejectem. */
  async function syncCalendar() {
    try {
      return await syncTaskCalendar(task.id);
    } catch {
      toast("Kalendář se nepodařilo aktualizovat.", "error");
      return null;
    }
  }

  /** Dopíše rozepsaný název a popis (onBlur ani debounce se při zavření
      nestihnou) a počká i na dřív rozběhnuté zápisy — jsou ve frontě před
      ním. false = něco se nepodařilo uložit. */
  async function flushPending() {
    const [titleOk, descOk] = await Promise.all([saveTitle(), saveDescription()]);
    return titleOk && descOk;
  }

  /** Zavření karty (Esc, ✕, Hotovo, klik vedle, timer): nejdřív uložit
      rozepsané; když se něco měnilo, ať se seznam pod kartou přenačte. */
  async function close() {
    if (closingRef.current) return;
    closingRef.current = true;
    try {
      // uložení selhalo (toast už byl) → zavřít jen na výslovné přání,
      // jinak karta zůstane otevřená a text se dá zkusit uložit znovu
      if (!(await flushPending())) {
        const discard = await confirmDialog({
          title: "Zavřít bez uložení?",
          message:
            "Název nebo popis se nepodařilo uložit. Zavřením karty se změna ztratí.",
          confirmLabel: "Zavřít",
        });
        if (!discard) return;
      }
      if (newComment.trim()) {
        const discard = await confirmDialog({
          title: "Zahodit rozepsaný komentář?",
          message: "Komentář ještě není odeslaný. Zavřením karty se ztratí.",
          confirmLabel: "Zahodit",
        });
        if (!discard) return;
      }
      if (changedRef.current) onChanged();
      else onClose();
    } finally {
      closingRef.current = false;
    }
  }
  // Esc má vždy po ruce aktuální close (listener se registruje jen jednou)
  closeRef.current = close;

  async function remove() {
    const ok = await confirmDialog({
      title: "Smazat kartu?",
      message: `Karta „${task.title}" se smaže i s komentáři. Odpracovaný čas zůstane v přehledech — s názvem karty v popisu. Tuto akci nelze vrátit.`,
    });
    if (!ok) return;
    // RLS cizí kartu neodmítne chybou, jen nic nesmaže (0 řádků)
    const { data, error } = await supabase
      .from("tasks")
      .delete()
      .eq("id", task.id)
      .select("id");
    if (error || !data?.length) {
      toast(
        error
          ? "Kartu se nepodařilo smazat."
          : "Smazat kartu může jen její autor nebo admin.",
        "error"
      );
      return;
    }
    onChanged();
  }

  // ---------------------------------------------------------------- štítky

  async function toggleLabel(label: Label) {
    const wasOn = taskLabels.has(label.id);
    setTaskLabels((prev) => {
      const next = new Set(prev);
      if (wasOn) next.delete(label.id);
      else next.add(label.id);
      return next;
    });
    const { error } = wasOn
      ? await supabase
          .from("task_labels")
          .delete()
          .eq("task_id", task.id)
          .eq("label_id", label.id)
      : await supabase
          .from("task_labels")
          .insert({ task_id: task.id, label_id: label.id });
    if (error) {
      toast("Změna štítku se nezdařila.", "error");
      loadLabels();
    }
  }

  async function createLabel(e: React.FormEvent) {
    e.preventDefault();
    const name = newLabel.trim();
    if (!name) return;
    const { data, error } = await supabase
      .from("labels")
      .insert({ workspace_id: task.workspace_id, name })
      .select("id")
      .single();
    if (error || !data) {
      toast("Štítek se nepodařilo založit (možná už existuje).", "error");
      return;
    }
    await supabase.from("task_labels").insert({ task_id: task.id, label_id: data.id });
    setNewLabel("");
    setAddingLabel(false);
    loadLabels();
  }

  // ---------------------------------------------------------------- podúkoly

  async function addSubtask(e: React.FormEvent) {
    e.preventDefault();
    const name = newSubtask.trim();
    if (!name || addingSubtask.current) return;
    addingSubtask.current = true;
    setNewSubtask(""); // hned prázdné — při chybě se text vrátí
    const { error } = await supabase.from("tasks").insert({
      workspace_id: task.workspace_id,
      project_id: task.project_id,
      parent_id: task.id,
      title: name,
    });
    addingSubtask.current = false;
    if (error) {
      toast("Podúkol se nepodařilo přidat.", "error");
      setNewSubtask((cur) => cur || name);
      return;
    }
    loadSubtasks();
  }

  async function toggleSubtask(sub: Task) {
    await supabase
      .from("tasks")
      .update({ completed_at: sub.completed_at ? null : new Date().toISOString() })
      .eq("id", sub.id);
    loadSubtasks();
  }

  async function removeSubtask(sub: Task) {
    // RLS cizí podúkol neodmítne chybou, jen nic nesmaže (0 řádků)
    const { data, error } = await supabase
      .from("tasks")
      .delete()
      .eq("id", sub.id)
      .select("id");
    if (error || !data?.length)
      toast(
        error
          ? "Podúkol se nepodařilo smazat."
          : "Smazat podúkol může jen jeho autor nebo admin.",
        "error"
      );
    loadSubtasks();
  }

  // ---------------------------------------------------------------- komentáře

  // ---------------------------------------------------------------- zmínky

  const mentionSuggestions =
    mentionQuery === null
      ? []
      : members
          .filter((m) => m.profiles?.tag_name)
          .filter((m) => {
            const q = mentionQuery.toLowerCase();
            return (
              m.profiles!.tag_name!.toLowerCase().startsWith(q) ||
              (m.profiles?.full_name ?? "").toLowerCase().includes(q)
            );
          })
          .slice(0, 6);

  function onCommentChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    setNewComment(value);
    const caret = e.target.selectionStart ?? value.length;
    const match = value.slice(0, caret).match(/@([a-zA-Z0-9_.]{0,30})$/);
    setMentionQuery(match ? match[1] : null);
    setMentionActive(0);
  }

  function pickMention(tag: string) {
    const caret = commentRef.current?.selectionStart ?? newComment.length;
    const before = newComment
      .slice(0, caret)
      .replace(/@[a-zA-Z0-9_.]{0,30}$/, `@${tag} `);
    setNewComment(before + newComment.slice(caret));
    setMentionQuery(null);
    commentRef.current?.focus();
  }

  function onCommentKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (mentionQuery === null || mentionSuggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setMentionActive((i) => Math.min(i + 1, mentionSuggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setMentionActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      pickMention(mentionSuggestions[mentionActive].profiles!.tag_name!);
    } else if (e.key === "Escape") {
      e.preventDefault(); // zavře jen našeptávač, ne kartu s rozepsaným komentářem
      setMentionQuery(null);
    }
  }

  async function addComment(e: React.FormEvent) {
    e.preventDefault();
    setMentionQuery(null);
    const body = newComment.trim();
    if (!body || sending) return;
    setSending(true);
    // author_id nastavíme výslovně (nespoléháme na auth.uid() default, který
    // při krátkém výpadku session selže) a text NEmažeme, dokud nemáme jistotu
    const { error } = await supabase.from("task_comments").insert({
      workspace_id: task.workspace_id,
      task_id: task.id,
      author_id: userId,
      body,
    });
    setSending(false);
    if (error) {
      toast("Komentář se nepodařilo uložit — zkus to znovu.", "error");
      return; // text zůstane v poli, uživatel o něj nepřijde
    }
    setNewComment("");
    pingNotifyEmails();
    loadComments();
  }

  async function removeComment(comment: TaskComment) {
    await supabase.from("task_comments").delete().eq("id", comment.id);
    loadComments();
  }

  async function play() {
    await startTimer(supabase, userId, {
      workspace_id: task.workspace_id,
      project_id: task.project_id,
      task_id: task.id,
      task_title: task.title,
    });
    await close(); // i tady uložit rozepsané a přenačíst seznam po změnách
  }

  const doneSubtasks = subtasks.filter((s) => s.completed_at).length;

  // jméno čekaného: člen z members, kontakt z embedded contacts
  const waitingMember = followup?.waiting_user_id
    ? members.find((m) => m.user_id === followup.waiting_user_id)
    : null;
  const waitingName = followup
    ? followup.waiting_user_id
      ? waitingMember?.profiles?.full_name || waitingMember?.profiles?.email || "člen"
      : followup.waiting_contact_id
        ? (followup.contacts?.name ?? "kontakt")
        : "—" // čekání bez osoby (ruční přetažení do Waiting on)
    : null;
  const followupSetter = followup
    ? members.find((m) => m.user_id === followup.created_by)
    : null;
  const canClearWaiting =
    !!followup && (followup.created_by === userId || isAdmin);

  useEffect(() => {
    if (mobileTab === "comments") setSeenComments(comments.length);
  }, [mobileTab, comments.length]);
  const unseenComments =
    seenComments !== null && comments.length > seenComments;

  // komentáře + systémová aktivita v jednom časovém toku
  const timeline: {
    id: string;
    at: string;
    comment?: TaskComment;
    act?: TaskActivity;
  }[] = [
    ...comments.map((c) => ({ id: `c-${c.id}`, at: c.created_at, comment: c })),
    ...activity.map((a) => ({ id: `a-${a.id}`, at: a.created_at, act: a })),
  ].sort((x, y) => y.at.localeCompare(x.at)); // nejnovější nahoře

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center overflow-y-auto bg-black/65 backdrop-blur-[2px] sm:items-start sm:p-10"
      onClick={close}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Karta: ${task.title}`}
        tabIndex={-1}
        className="pb-safe flex w-full flex-col bg-surface shadow-xl outline-none sm:h-[86vh] sm:max-w-5xl sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* horní lišta: projekt (přesun karty mezi projekty) + zavřít */}
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5 sm:px-4">
          {(isAdmin || (!task.project_id && task.created_by === userId)) &&
          projects.length > 0 ? (
            <ProjectPicker
              projects={projects}
              value={projectId}
              onChange={saveProject}
              align="left"
              alwaysSearch
              onCreate={isAdmin ? createProjectAndSelect : undefined}
            />
          ) : (
            <span className="chip max-w-[65%] truncate px-2 py-1 text-sm">
              {projects.find((p) => p.id === projectId)?.name ?? "Bez projektu"}
            </span>
          )}
          {isPrivate && (
            <span
              className="rounded-full bg-black/5 px-2 py-0.5 text-xs text-ink-soft"
              title="Skrytý úkol — vidí ho jen jeho autor."
            >
              🔒 skrytý
            </span>
          )}
          <span className="flex-1" />
          {/* stav autosave — pole se ukládají sama */}
          <span
            aria-live="polite"
            className={`text-xs transition-opacity ${
              saveState === "idle" ? "opacity-0" : "text-ink-soft/60 opacity-100"
            }`}
          >
            {saveState === "saving" ? "Ukládám…" : "Uloženo"}
          </span>
          <button
            type="button"
            onClick={async () => {
              const url = `${window.location.origin}/t/${task.id}`;
              try {
                await navigator.clipboard.writeText(url);
                toast("Odkaz na úkol zkopírován.");
              } catch {
                toast(url, "error");
              }
            }}
            aria-label="Sdílet — zkopírovat odkaz na úkol"
            title="Sdílet — zkopírovat odkaz na úkol"
            className="rounded-md px-2 py-1 text-ink-soft/70 hover:bg-black/5"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </button>
          <button
            onClick={close}
            aria-label="Zavřít kartu"
            className="rounded-md px-2 py-1 text-ink-soft/70 hover:bg-black/5"
          >
            ✕
          </button>
        </div>

        {/* mobil: záložky Úkol / Komentáře; každá má vlastní scroll v celé výšce */}
        <div
          role="tablist"
          aria-label="Části karty"
          className="flex shrink-0 border-b border-line sm:hidden"
        >
          {(["task", "comments"] as const).map((tab) => {
            const active = mobileTab === tab;
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setMobileTab(tab)}
                className={`relative flex flex-1 items-center justify-center gap-1.5 py-2.5 text-sm font-medium transition-colors ${
                  active ? "text-accent" : "text-ink-soft/70"
                }`}
              >
                {tab === "task" ? "Úkol" : "Komentáře"}
                {tab === "comments" && comments.length > 0 && (
                  <span
                    className={`rounded-full px-1.5 text-xs ${
                      active ? "bg-accent-soft text-accent" : "bg-black/5 text-ink-soft"
                    }`}
                  >
                    {comments.length}
                  </span>
                )}
                {tab === "comments" && !active && unseenComments && (
                  <span
                    className="h-2 w-2 rounded-full bg-accent"
                    aria-label="Nové komentáře"
                  />
                )}
                {active && (
                  <span className="absolute inset-x-8 bottom-0 h-0.5 rounded-full bg-accent" />
                )}
              </button>
            );
          })}
        </div>

        {/* tělo: obsah vlevo, komentáře/aktivita vpravo (na mobilu záložky) */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden sm:flex-row">
          <div
            className={`min-w-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-4 sm:block sm:p-5 ${
              mobileTab === "task" ? "" : "hidden"
            }`}
          >
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={done}
                onChange={(e) => saveDone(e.target.checked)}
                className="mt-1.5 h-4 w-4"
                title="Hotovo"
              />
              <textarea
                ref={autoGrow}
                rows={1}
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  autoGrow(e.currentTarget);
                }}
                onBlur={saveTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.currentTarget.blur();
                  }
                }}
                aria-label="Název"
                className="min-w-0 flex-1 resize-none overflow-hidden rounded-md border border-transparent px-2 py-1 text-lg font-semibold leading-snug hover:border-line focus:border-line"
              />
            </div>

        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={saveDescription}
          placeholder="Popis…"
          rows={4}
          className="input w-full px-3 py-2"
        />

        {/* URL z popisu jako klikací odkazy (popis je editovatelná
            textarea, sama o sobě odkazy neumí — např. odkazy z Tektosu) */}
        {descriptionLinks.length > 0 && (
          <div className="-mt-1 flex flex-wrap gap-1.5">
            {descriptionLinks.map((url) => (
              <a
                key={url}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="chip inline-flex max-w-full items-center gap-1 hover:text-accent"
                title={url}
              >
                <span className="truncate">
                  {url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                </span>
                <span aria-hidden>↗</span>
              </a>
            ))}
          </div>
        )}

        {/* řešitel + vedoucí: desktop na jednom řádku, mobil popisek | hodnota */}
        <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-y-2.5 sm:flex sm:flex-wrap sm:gap-x-4 sm:gap-y-1.5">
          <div className="contents sm:flex sm:items-center sm:gap-1.5">
          <span className="text-sm text-ink-soft/70 sm:text-xs">Řešitel:</span>
          {canEditAssignee ? (
            <PersonPicker
              wsId={task.workspace_id}
              userId={userId}
              members={assignable.filter((m) => canManage(m.user_id))}
              contacts={contacts}
              value={currentAssigneeRef}
              onChange={setSingleAssignee}
              onContactCreated={addContact}
              noneLabel="— nikdo —"
              placeholder="+ řešitel"
              ariaLabel="Řešitel"
            />
          ) : currentMemberId ? (
            // cizí přiřazení bez oprávnění jen zobrazit
            (() => {
              const m = members.find((x) => x.user_id === currentMemberId);
              const name = m?.profiles?.full_name || m?.profiles?.email || "?";
              return (
                <span
                  className="inline-flex items-center gap-1.5 rounded-full border border-transparent bg-accent/70 py-0.5 pl-0.5 pr-2 text-xs text-white"
                  title="Řešitele může změnit admin nebo pověřený kolega"
                >
                  <Avatar profile={m?.profiles} colorKey={currentMemberId} size="xs" />
                  {name}
                </span>
              );
            })()
          ) : (
            <span className="text-xs text-ink-soft/50">nikdo</span>
          )}
          </div>

          {/* vedoucí — nastavuje jen admin; ostatní jen vidí, kdo úkol vede */}
          {(isAdmin || leadId) && (
            <div className="contents sm:flex sm:items-center sm:gap-1.5">
              <span className="text-sm text-ink-soft/70 sm:text-xs">Vedoucí:</span>
            {isAdmin ? (
              <PersonPicker
                wsId={task.workspace_id}
                userId={userId}
                members={members}
                contacts={contacts}
                value={leadId ? `u:${leadId}` : null}
                onChange={setLead}
                allowGhosts={false}
                noneLabel="— nikdo —"
                placeholder="+ vedoucí"
                ariaLabel="Vedoucí"
              />
            ) : (
              (() => {
                const m = members.find((x) => x.user_id === leadId);
                const name = m?.profiles?.full_name || m?.profiles?.email || "?";
                return (
                  <span
                    className="inline-flex items-center gap-1.5 rounded-full bg-ink-soft/15 py-0.5 pl-0.5 pr-2 text-xs"
                    title="Vedoucího úkolu nastavuje admin"
                  >
                    <Avatar profile={m?.profiles} colorKey={leadId!} size="xs" />
                    {name}
                  </span>
                );
              })()
            )}
            </div>
          )}
        </div>

        {/* follow-up: úkol čeká na dodání členem či externím kontaktem;
            nastavují jen delegátoři (admin / can_delegate), chip vidí všichni */}
        {(canDelegate || followup) && (
        <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-y-2 sm:flex sm:flex-wrap sm:gap-1.5">
          <span className="text-sm text-ink-soft/70 sm:text-xs">Čekám na:</span>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {followup ? (
            <>
              <span
                className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800"
                title={`Follow-up nastavil/a ${
                  followupSetter?.profiles?.full_name ||
                  followupSetter?.profiles?.email ||
                  "kolega"
                }`}
              >
                ⏳ {waitingName}
              </span>
              {/* od kdy čekám / do kdy slíbil dodat — editovatelné */}
              <label className="flex items-center gap-1 text-xs text-ink-soft/70">
                od
                <input
                  type="date"
                  value={followup.waiting_since ?? localDate(followup.created_at)}
                  disabled={!canClearWaiting}
                  onChange={(e) =>
                    e.target.value && patchFollowup({ waiting_since: e.target.value })
                  }
                  className="input min-w-0 max-w-full px-1.5 py-0.5 text-xs disabled:opacity-70"
                />
              </label>
              <label className="flex items-center gap-1 text-xs text-ink-soft/70">
                do
                <input
                  type="date"
                  value={followup.waiting_until ?? ""}
                  disabled={!canClearWaiting}
                  title="Do kdy slíbil/a dodat"
                  onChange={(e) =>
                    patchFollowup({ waiting_until: e.target.value || null })
                  }
                  className="input min-w-0 max-w-full px-1.5 py-0.5 text-xs disabled:opacity-70"
                />
              </label>
              {/* čekání bez osoby (přetažení do Waiting on) — doplnit, na koho */}
              {!followup.waiting_user_id &&
                !followup.waiting_contact_id &&
                (canClearWaiting || canDelegate) && (
                  <PersonPicker
                    wsId={task.workspace_id}
                    userId={userId}
                    members={members}
                    contacts={contacts}
                    value={null}
                    onChange={(ref) => ref && assignWaiting(ref)}
                    onContactCreated={addContact}
                    includeMe={false}
                    placeholder="doplnit, na koho"
                    ariaLabel="Doplnit, na koho se čeká"
                    iconPath={HOURGLASS_ICON}
                  />
                )}
              {canClearWaiting && (
                <button
                  onClick={stopWaiting}
                  className="rounded-full px-2 py-0.5 text-xs text-ink-soft/70 hover:bg-black/5"
                >
                  Zrušit čekání
                </button>
              )}
            </>
          ) : (
            <PersonPicker
              wsId={task.workspace_id}
              userId={userId}
              members={members}
              contacts={contacts}
              value={null}
              onChange={(ref) => ref && startWaiting(ref)}
              onContactCreated={addContact}
              includeMe={false}
              placeholder="nastavit follow-up"
              ariaLabel="Čekám na"
              iconPath={HOURGLASS_ICON}
            />
          )}
          </div>
        </div>
        )}

        {/* termín, priorita, opakování, timer: mobil v řádcích s popisky */}
        <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-y-2 sm:flex sm:flex-wrap sm:gap-2">
          <span className="text-sm text-ink-soft/70 sm:hidden">Termín:</span>
          <input
            type="date"
            value={dueDate}
            onChange={(e) =>
              saveChoice("due_date", e.target.value, setDueDate, e.target.value || null)
            }
            aria-label="Termín"
            className="input h-10 w-full min-w-0 max-w-full px-2 py-1 sm:h-auto sm:w-auto"
          />
          <span className="text-sm text-ink-soft/70 sm:hidden">Priorita:</span>
          <select
            value={priority}
            onChange={(e) =>
              saveChoice("priority", Number(e.target.value), setPriority)
            }
            aria-label="Priorita"
            style={{ color: priorityColor(priority) ?? undefined }}
            className="input h-10 w-full px-2 sm:h-auto sm:w-auto"
          >
            {PRIORITIES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <span className="text-sm text-ink-soft/70 sm:hidden">Opakování:</span>
          <select
            value={recurrence}
            onChange={(e) =>
              saveChoice(
                "recurrence",
                e.target.value,
                setRecurrence,
                (e.target.value || null) as Recurrence | null
              )
            }
            aria-label="Opakování"
            className="input h-10 w-full px-2 sm:h-auto sm:w-auto"
          >
            {RECURRENCE_OPTIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <button
            onClick={play}
            className="col-span-2 h-10 rounded-md border border-accent/50 px-3 py-1.5 text-sm text-accent hover:bg-accent-soft sm:col-span-1 sm:h-auto"
          >
            ▶ Spustit timer
          </button>
          {canTogglePrivate && (
            <label
              className="col-span-2 flex cursor-pointer items-center gap-1.5 text-sm text-ink-soft sm:col-span-1"
              title="Skrytý úkol vidí jen jeho autor — řešitelé, ostatní ani admin ne. Nechodí z něj žádné notifikace."
            >
              <input
                type="checkbox"
                checked={isPrivate}
                onChange={(e) =>
                  saveChoice("is_private", e.target.checked, setIsPrivate)
                }
                className="h-4 w-4"
              />
              🔒 Skrytý
            </label>
          )}
        </div>
        {recurrence && (
          <p className="text-xs text-ink-soft/70">
            Po dokončení se automaticky založí další výskyt s posunutým termínem.
          </p>
        )}

        {/* plánované okno — kdy na tom budu dělat; propíše se do kalendáře
            „Kronos" řešitelů (Google Workspace) */}
        <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-y-2 sm:flex sm:flex-wrap sm:gap-1.5">
          <span
            className="text-sm text-ink-soft/70 sm:text-xs"
            title="Naplánované okno se uloží řešitelům do Google kalendáře „Kronos“."
          >
            🗓 Plán:
          </span>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <input
            type="date"
            value={planDate}
            onChange={(e) => {
              setPlanDate(e.target.value);
              savePlan(e.target.value, planFrom, planTo);
            }}
            aria-label="Den plánu"
            className="input h-10 w-full min-w-0 max-w-full px-2 py-1 text-sm sm:h-auto sm:w-auto"
          />
          <input
            type="time"
            value={planFrom}
            onChange={(e) => {
              setPlanFrom(e.target.value);
              savePlan(planDate, e.target.value, planTo);
            }}
            aria-label="Plán od"
            className="input h-10 min-w-0 flex-1 px-2 py-1 text-sm sm:h-auto sm:flex-none"
          />
          <span className="text-ink-soft/50">–</span>
          <input
            type="time"
            value={planTo}
            onChange={(e) => {
              setPlanTo(e.target.value);
              savePlan(planDate, planFrom, e.target.value);
            }}
            aria-label="Plán do"
            className="input h-10 min-w-0 flex-1 px-2 py-1 text-sm sm:h-auto sm:flex-none"
          />
          {(planDate || planFrom || planTo) && (
            <button
              onClick={clearPlan}
              aria-label="Zrušit plán"
              title="Zrušit plán (smaže i událost v kalendáři)"
              className="rounded px-1.5 py-1 text-sm text-ink-soft/50 hover:text-danger"
            >
              ×
            </button>
          )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {labels.map((label) => {
            const on = taskLabels.has(label.id);
            return (
              <button
                key={label.id}
                onClick={() => toggleLabel(label)}
                aria-pressed={on}
                className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
                  on
                    ? "border-transparent text-white"
                    : "border-line text-ink-soft hover:border-ink-soft/40"
                }`}
                style={on ? { background: projectColor(label.id) } : undefined}
              >
                {label.name}
              </button>
            );
          })}
          {addingLabel ? (
            <form onSubmit={createLabel} className="inline-flex gap-1">
              <input
                autoFocus
                type="text"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onBlur={() => !newLabel.trim() && setAddingLabel(false)}
                placeholder="Název štítku…"
                className="input w-32 px-2 py-0.5 text-xs"
              />
              <button type="submit" className="btn-primary px-2 py-0.5 text-xs">
                OK
              </button>
            </form>
          ) : (
            <button
              onClick={() => setAddingLabel(true)}
              className="rounded-full px-2 py-0.5 text-xs text-ink-soft/70 hover:bg-black/5"
            >
              + štítek
            </button>
          )}
        </div>

        <div className="space-y-1.5 border-t border-line/70 pt-3">
          <h3 className="text-sm font-semibold">
            Podúkoly
            {subtasks.length > 0 && (
              <span className="ml-2 text-xs font-normal text-ink-soft/70">
                {doneSubtasks}/{subtasks.length}
              </span>
            )}
          </h3>
          {subtasks.map((sub) => (
            <div key={sub.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={!!sub.completed_at}
                onChange={() => toggleSubtask(sub)}
                className="h-3.5 w-3.5"
              />
              <span
                className={`flex-1 text-sm ${
                  sub.completed_at ? "text-ink-soft/70 line-through" : ""
                }`}
              >
                {sub.title}
              </span>
              <button
                onClick={() => removeSubtask(sub)}
                aria-label={`Smazat podúkol ${sub.title}`}
                className="rounded px-1.5 text-xs text-ink-soft/50 hover:text-danger"
              >
                ×
              </button>
            </div>
          ))}
          <form onSubmit={addSubtask} className="flex gap-2">
            <input
              type="text"
              placeholder="+ Přidat podúkol…"
              value={newSubtask}
              onChange={(e) => setNewSubtask(e.target.value)}
              className="input-quiet flex-1 px-2 py-1 text-sm"
            />
            {newSubtask.trim() && (
              <button type="submit" className="btn-primary px-2 py-0.5 text-xs">
                OK
              </button>
            )}
          </form>
        </div>

            <CardChecklists taskId={task.id} workspaceId={task.workspace_id} />

            <CardAttachments
              taskId={task.id}
              workspaceId={task.workspace_id}
              userId={userId}
            />

            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>

          {/* pravý panel: komentáře a aktivita — nejnovější nahoře,
              psaní hned pod hlavičkou */}
          <div
            className={`w-full min-w-0 flex-col border-line bg-paper/40 sm:flex sm:w-96 sm:flex-none sm:overflow-hidden sm:border-l lg:w-[28rem] ${
              mobileTab === "comments" ? "flex min-h-0 flex-1 overflow-hidden" : "hidden"
            }`}
          >
            <h3 className="hidden border-b border-line px-4 py-2.5 text-sm font-semibold sm:block">
              Komentáře a aktivita
            </h3>
            <form onSubmit={addComment} className="flex gap-2 border-b border-line p-3">
            <div className="relative flex-1">
              {mentionQuery !== null && mentionSuggestions.length > 0 && (
                <ul
                  role="listbox"
                  aria-label="Zmínit uživatele"
                  className="absolute left-0 top-full z-10 mt-1 w-64 overflow-hidden rounded-xl border border-line bg-surface p-1 shadow-lg"
                >
                  {mentionSuggestions.map((m, i) => (
                    <li key={m.user_id} role="option" aria-selected={i === mentionActive}>
                      <button
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault(); // neztratit fokus inputu
                          pickMention(m.profiles!.tag_name!);
                        }}
                        onMouseEnter={() => setMentionActive(i)}
                        className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${
                          i === mentionActive ? "bg-accent-soft" : ""
                        }`}
                      >
                        <Avatar
                          profile={m.profiles}
                          colorKey={m.user_id}
                          size="sm"
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {m.profiles?.full_name || m.profiles?.email}
                        </span>
                        <span className="text-xs text-accent">
                          @{m.profiles?.tag_name}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <input
                ref={commentRef}
                type="text"
                placeholder="Napsat komentář… (@ zmíní kolegu)"
                value={newComment}
                onChange={onCommentChange}
                onKeyDown={onCommentKeyDown}
                onBlur={() => setMentionQuery(null)}
                className="w-full input"
              />
            </div>
            <button
              type="submit"
              disabled={sending || !newComment.trim()}
              className="btn-primary disabled:opacity-60"
            >
              {sending ? "…" : "Odeslat"}
            </button>
            </form>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
              {timeline.length === 0 && (
                <p className="text-xs text-ink-soft/70">Zatím žádná aktivita.</p>
              )}
              {timeline.map((row) =>
                row.comment ? (
                  <div key={row.id} className="rounded-lg border border-line bg-surface p-2">
                    <div className="flex items-center gap-2">
                      <Avatar
                        profile={row.comment.profiles}
                        colorKey={row.comment.author_id}
                        size="sm"
                      />
                      <span className="min-w-0 truncate text-xs font-medium">
                        {row.comment.profiles?.full_name ||
                          row.comment.profiles?.email}
                      </span>
                      <span className="shrink-0 text-[10px] text-ink-soft/70">
                        {fmtStamp(row.comment.created_at)}
                      </span>
                      {row.comment.author_id === userId && (
                        <button
                          onClick={() => removeComment(row.comment!)}
                          className="ml-auto shrink-0 text-[10px] text-ink-soft/70 hover:text-danger"
                        >
                          smazat
                        </button>
                      )}
                    </div>
                    <CommentBody body={row.comment.body} />
                  </div>
                ) : (
                  <p key={row.id} className="px-1 text-xs text-ink-soft/70">
                    <span className="font-medium text-ink-soft">
                      {row.act!.profiles?.full_name ||
                        row.act!.profiles?.email ||
                        "Systém"}
                    </span>{" "}
                    {activityText(row.act!)}
                    <span className="text-ink-soft/50">
                      {" · "}
                      {fmtStamp(row.act!.created_at)}
                    </span>
                  </p>
                )
              )}
            </div>
          </div>
        </div>

        {/* patička přes celou šířku */}
        <div className="flex shrink-0 items-center justify-between border-t border-line px-3 py-2.5 sm:px-4">
          <button
            onClick={remove}
            className="rounded-md px-2 py-1 text-sm text-danger hover:bg-danger/10"
          >
            Smazat kartu
          </button>
          {/* karta se ukládá průběžně — tohle jen zavře a přenačte seznam */}
          <button onClick={close} className="btn-primary">
            Hotovo
          </button>
        </div>
      </div>
    </div>
  );
}
