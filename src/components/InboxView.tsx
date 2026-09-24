"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { createClient } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";
import { confirmDialog } from "@/lib/confirm";
import { pingNotifyEmails } from "@/lib/notify";
import { notifyTasksChanged, TASKS_CHANGED_EVENT } from "@/lib/tasksChanged";
import { cacheGet, cacheSet } from "@/lib/viewCache";
import ProjectPicker from "@/components/ProjectPicker";
import PersonPicker, { HOURGLASS_ICON } from "@/components/PersonPicker";
import TaskRow, { TaskGroup } from "@/components/TaskRow";
import LoadError from "@/components/LoadError";
import type { Contact, Membership, Project, Task } from "@/lib/types";
import { ListSkeleton } from "@/components/Skeletons";

// Modal se načte až při otevření karty — nezatěžuje základní bundle routy.
const CardModal = dynamic(() => import("@/components/CardModal"), { ssr: false });

/** Rozpracované třídění řádku: co už uživatel vybral (zapsáno v DB). */
type SortState = {
  project: string | null;
  /** "u:<userId>" (člen) | "c:<contactId>" (duch) */
  assignee: string | null;
  /** "u:<userId>" | "c:<contactId>" */
  waiting: string | null;
};

const EMPTY_SORT: SortState = { project: null, assignee: null, waiting: null };

/** GTD Inbox: rychle nabouchané úkoly bez projektu, řešitele a follow-upu.
    Třídící volby se ukládají hned, ale řádek zůstává (jde měnit názor),
    dokud uživatel nepotvrdí „Utříděno" — teprve pak z Inboxu zmizí.
    Po novém načtení stránky se zatříděné úkoly už nenačtou. */
export default function InboxView({
  wsId,
  userId,
  canDelegate,
}: {
  wsId: string;
  userId: string;
  canDelegate: boolean;
}) {
  const supabase = createClient();
  // poslední načtený stav (stale-while-revalidate, lib/viewCache)
  const cacheKey = `inbox:${wsId}:${userId}`;
  const cached = cacheGet<{
    tasks: Task[];
    members: Membership[];
    contacts: Contact[];
    grants: string[];
  }>(cacheKey);
  const [tasks, setTasks] = useState<Task[]>(cached?.tasks ?? []);
  const [members, setMembers] = useState<Membership[]>(cached?.members ?? []);
  const [contacts, setContacts] = useState<Contact[]>(cached?.contacts ?? []);
  const [grants, setGrants] = useState<Set<string>>(new Set(cached?.grants ?? []));
  const [loading, setLoading] = useState(!cached);
  const [loadError, setLoadError] = useState(false);
  // pořadí načítání: starší odpověď by vrátila řádek, který se právě utřídil
  const loadSeq = useRef(0);
  const [openTask, setOpenTask] = useState<Task | null>(null);
  // rozpracované třídění — ref kvůli merge v load() bez závodu se setState;
  // render čte jeho kopii `sorts` (ref se během renderu číst nesmí)
  const sortRef = useRef<Record<string, SortState>>({});
  const [sorts, setSorts] = useState<Record<string, SortState>>({});

  function patchSort(taskId: string, patch: Partial<SortState> | null) {
    if (patch === null) delete sortRef.current[taskId];
    else
      sortRef.current[taskId] = {
        ...(sortRef.current[taskId] ?? EMPTY_SORT),
        ...patch,
      };
    setSorts({ ...sortRef.current });
  }

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const [tRes, memRes, fuRes, grantRes, cRes] = await Promise.all([
      supabase
        .from("tasks")
        .select(
          "*, projects(name, position), task_assignees(user_id), task_contact_assignees(contact_id)"
        )
        .eq("workspace_id", wsId)
        .eq("created_by", userId)
        .is("project_id", null)
        .is("completed_at", null)
        .is("parent_id", null)
        .is("triaged_at", null)
        .order("created_at"),
      supabase
        .from("workspace_members")
        .select(
          "*, profiles(id, email, full_name, is_super_admin, avatar_initials, avatar_color, tag_name)"
        )
        .eq("workspace_id", wsId),
      supabase
        .from("task_followups")
        .select("task_id")
        .eq("workspace_id", wsId)
        .eq("created_by", userId),
      supabase
        .from("assign_grants")
        .select("target_id")
        .eq("workspace_id", wsId)
        .eq("user_id", userId),
      supabase.from("contacts").select("*").eq("workspace_id", wsId).order("name"),
    ]);
    if (seq !== loadSeq.current) return;
    // chyba ≠ „vše zatříděno": necháme, co je vidět, a nic necachujeme
    if (tRes.error || memRes.error || fuRes.error || grantRes.error || cRes.error) {
      setLoading(false);
      setLoadError(true);
      return;
    }
    setLoadError(false);
    const waiting = new Set((fuRes.data ?? []).map((r) => r.task_id as string));
    // v Inboxu je i úkol, kde jsem jediný řešitel já — pořád není zatříděný
    const fresh = ((tRes.data ?? []) as unknown as (Task & {
      task_assignees?: { user_id: string }[];
      task_contact_assignees?: { contact_id: string }[];
    })[]).filter(
      (t) =>
        (t.task_assignees ?? []).every((a) => a.user_id === userId) &&
        (t.task_contact_assignees ?? []).length === 0 &&
        !waiting.has(t.id)
    );
    // řešitel z DB (typicky já) ať je v řádku vidět hned po načtení
    for (const t of fresh) {
      const mine = (t.task_assignees ?? [])[0]?.user_id;
      if (mine && !sortRef.current[t.id])
        sortRef.current[t.id] = { ...EMPTY_SORT, assignee: `u:${mine}` };
    }
    setSorts({ ...sortRef.current });
    // rozpracované (už zatříděné v DB, ale nepotvrzené) řádky nechat viset
    setTasks((prev) => {
      const freshIds = new Set(fresh.map((t) => t.id));
      const inProgress = prev.filter(
        (t) => !freshIds.has(t.id) && sortRef.current[t.id]
      );
      return [...fresh, ...inProgress];
    });
    const nextMembers = (memRes.data as unknown as Membership[]) ?? [];
    const nextGrants = (grantRes.data ?? []).map((r) => r.target_id as string);
    const nextContacts = (cRes.data as Contact[]) ?? [];
    setMembers(nextMembers);
    setGrants(new Set(nextGrants));
    setContacts(nextContacts);
    setLoading(false);
    cacheSet(cacheKey, {
      tasks: fresh,
      members: nextMembers,
      contacts: nextContacts,
      grants: nextGrants,
    });
  }, [supabase, wsId, userId, cacheKey]);

  useEffect(() => {
    load();
    const onChanged = () => load();
    window.addEventListener(TASKS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(TASKS_CHANGED_EVENT, onChanged);
  }, [load]);

  // projekty pro řádkový picker
  const [projects, setProjects] = useState<Project[]>([]);
  const loadProjects = useCallback(async () => {
    const { data, error } = await supabase
      .from("projects")
      .select("*")
      .eq("workspace_id", wsId)
      .eq("archived", false)
      .order("position")
      .order("name");
    if (error) return; // chyba ≠ žádné projekty — picker nechá předchozí seznam
    setProjects((data as Project[]) ?? []);
  }, [supabase, wsId]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const me = members.find((m) => m.user_id === userId);
  const isAdmin = !!(me?.profiles?.is_super_admin || me?.role === "admin");
  // komu smím zadávat: admin komukoli, člen sobě + s grantem
  const assignable = members.filter(
    (m) => isAdmin || m.user_id === userId || grants.has(m.user_id)
  );

  // ------------------------------------------------------- třídění (průběžné)
  // Každá volba se hned zapíše do DB, ale řádek visí dál — jde měnit názor.
  // Z Inboxu ho odsune až „Utříděno" (nebo hotovo/smazat/reload stránky).

  async function setProject(task: Task, projectId: string | null) {
    const { error } = await supabase
      .from("tasks")
      .update({ project_id: projectId, column_id: null })
      .eq("id", task.id);
    if (error) {
      toast("Přesun do projektu se nezdařil.", "error");
      return;
    }
    patchSort(task.id, { project: projectId });
  }

  /** value: "u:<userId>" (člen) nebo "c:<contactId>" (duch); null = zrušit. */
  async function assign(task: Task, value: string | null) {
    const prev = sortRef.current[task.id]?.assignee ?? null;
    if (prev === value) return;
    if (prev) {
      const prevId = prev.slice(2);
      if (prev.startsWith("u:"))
        await supabase
          .from("task_assignees")
          .delete()
          .eq("task_id", task.id)
          .eq("user_id", prevId);
      else
        await supabase
          .from("task_contact_assignees")
          .delete()
          .eq("task_id", task.id)
          .eq("contact_id", prevId);
    }
    if (value) {
      const id = value.slice(2);
      const { error } = value.startsWith("u:")
        ? await supabase
            .from("task_assignees")
            .insert({ task_id: task.id, user_id: id })
        : await supabase
            .from("task_contact_assignees")
            .insert({ task_id: task.id, contact_id: id });
      if (error) {
        toast("Řešitele se nepodařilo přiřadit.", "error");
        return;
      }
      if (value.startsWith("u:")) pingNotifyEmails();
    }
    patchSort(task.id, { assignee: value });
  }

  /** Nový duch z „➕ založit" v PersonPickeru — jen doplnit do seznamu. */
  function addContact(contact: Contact) {
    setContacts((prev) =>
      [...prev, contact].sort((a, b) => a.name.localeCompare(b.name, "cs"))
    );
  }

  /** value: "u:<userId>" nebo "c:<contactId>" — jako v kartě; null = zrušit. */
  async function setWaiting(task: Task, value: string | null) {
    const prev = sortRef.current[task.id]?.waiting ?? null;
    if (prev === value) return;
    if (prev) {
      await supabase.from("task_followups").delete().eq("task_id", task.id);
    }
    if (value) {
      const id = value.slice(2);
      const { error } = await supabase.from("task_followups").insert({
        task_id: task.id,
        workspace_id: wsId,
        created_by: userId,
        waiting_user_id: value.startsWith("u:") ? id : null,
        waiting_contact_id: value.startsWith("c:") ? id : null,
      });
      if (error) {
        toast("Čekání se nepodařilo nastavit.", "error");
        return;
      }
    }
    patchSort(task.id, { waiting: value });
  }

  /** „➕ založit projekt" z pickeru (jen admin — RLS) a rovnou přiřadit. */
  async function createProjectAndMove(task: Task, name: string) {
    const { data, error } = await supabase
      .from("projects")
      .insert({ workspace_id: wsId, name })
      .select("id")
      .single();
    if (error || !data) {
      toast("Projekt se nepodařilo založit.", "error");
      return;
    }
    await loadProjects();
    await setProject(task, data.id as string);
  }

  // ---------------------------------------------------------------- odsunutí

  function dismiss(task: Task) {
    patchSort(task.id, null);
    setTasks((prev) => prev.filter((t) => t.id !== task.id));
    notifyTasksChanged(); // počítadlo v navigaci i reload Inboxu (posluchač)
  }

  async function markSorted(task: Task) {
    const s = sortRef.current[task.id];
    // razítko roztřídění — bez něj by se úkol „jen pro mě" vracel po reloadu
    const { error } = await supabase
      .from("tasks")
      .update({ triaged_at: new Date().toISOString() })
      .eq("id", task.id);
    if (error) {
      toast("Uložení se nezdařilo.", "error");
      return;
    }
    const assigneeText = !s?.assignee
      ? null
      : s.assignee === `u:${userId}`
        ? "Moje úkoly"
        : s.assignee.startsWith("u:")
          ? members.find((m) => m.user_id === s.assignee!.slice(2))?.profiles
              ?.full_name
          : `👻 ${contacts.find((c) => c.id === s.assignee!.slice(2))?.name ?? "duch"}`;
    const where = [
      s?.project ? (projects.find((p) => p.id === s.project)?.name ?? "projekt") : null,
      assigneeText,
      s?.waiting ? "Čekám na" : null,
    ].filter(Boolean);
    toast(`Utříděno: ${task.title}${where.length ? ` → ${where.join(", ")}` : ""}`);
    dismiss(task);
  }

  async function done(task: Task) {
    const { error } = await supabase
      .from("tasks")
      .update({ completed_at: new Date().toISOString() })
      .eq("id", task.id);
    if (error) {
      toast("Uložení se nezdařilo.", "error");
      return;
    }
    toast(`Hotovo: ${task.title}`);
    dismiss(task);
  }

  async function remove(task: Task) {
    const ok = await confirmDialog({
      title: "Smazat úkol?",
      message: `„${task.title}" se nenávratně smaže.`,
      confirmLabel: "Smazat",
    });
    if (!ok) return;
    await supabase.from("tasks").delete().eq("id", task.id);
    dismiss(task);
  }

  if (loading) return <ListSkeleton />;
  // „Zkusit znovu" načte i projekty pro picker (padají se stejným výpadkem)
  const retry = () => {
    load();
    loadProjects();
  };
  // chyba a nic dřív načteného: hláška místo „Vše zatříděno"
  if (loadError && tasks.length === 0)
    return <LoadError onRetry={retry} message="Inbox se nepodařilo načíst." />;

  return (
    <div className="w-full space-y-4">
      <div>
        <h1 className="font-display text-lg font-semibold">Inbox</h1>
        <p className="text-xs text-ink-soft/70">
          {tasks.length === 0
            ? "Vše zatříděno. 🎉 Nový úkol založíš tlačítkem +."
            : `${tasks.length} nezatříděných — vyber projekt, řešitele či follow-up a potvrď Utříděno`}
        </p>
      </div>

      {loadError && (
        <LoadError onRetry={retry} message="Inbox se nepodařilo obnovit." stale />
      )}

      {tasks.length > 0 && (
        <TaskGroup label="Nezatříděné" count={tasks.length}>
          {tasks.map((task) => {
            const s = sorts[task.id] ?? EMPTY_SORT;
            const touched = !!(s.project || s.assignee || s.waiting);
            return (
              <TaskRow
                key={task.id}
                task={task}
                onOpen={setOpenTask}
                onToggleDone={done}
                showProject={false}
                compactMobile
                /* třídící volby — ukládají se hned, řádek visí do potvrzení */
                actions={
                  <>
                  <ProjectPicker
                    projects={projects}
                    value={s.project}
                    onChange={(id) => setProject(task, id)}
                    align="right"
                    hideLabelOnMobile
                    alwaysSearch
                    onCreate={
                      isAdmin ? (name) => createProjectAndMove(task, name) : undefined
                    }
                  />
                  <PersonPicker
                    wsId={wsId}
                    userId={userId}
                    members={assignable}
                    contacts={contacts}
                    value={s.assignee}
                    onChange={(ref) => assign(task, ref)}
                    onContactCreated={addContact}
                    noneLabel="Bez řešitele"
                    placeholder="Řešitel"
                    ariaLabel="Řešitel"
                    align="right"
                    hideLabelOnMobile
                  />
                  {canDelegate && (
                    <PersonPicker
                      wsId={wsId}
                      userId={userId}
                      members={members}
                      contacts={contacts}
                      value={s.waiting}
                      onChange={(ref) => setWaiting(task, ref)}
                      onContactCreated={addContact}
                      includeMe={false}
                      noneLabel="— nikdo —"
                      placeholder="Čekám na"
                      ariaLabel="Čekám na"
                      iconPath={HOURGLASS_ICON}
                      align="right"
                      hideLabelOnMobile
                    />
                  )}
                  <button
                    onClick={() => markSorted(task)}
                    disabled={!touched}
                    title={
                      touched
                        ? "Hotovo s tříděním — odsunout z Inboxu"
                        : "Nejdřív vyber projekt, řešitele nebo follow-up"
                    }
                    className="rounded-md border border-accent/50 px-2 py-1 text-xs text-accent transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Utříděno ✓
                  </button>
                  <button
                    onClick={() => remove(task)}
                    aria-label={`Smazat ${task.title}`}
                    title="Smazat"
                    className="rounded px-1.5 py-1 text-sm text-ink-soft/50 hover:text-danger"
                  >
                    ×
                  </button>
                  </>
                }
              />
            );
          })}
        </TaskGroup>
      )}

      {openTask && (
        <CardModal
          task={openTask}
          members={members}
          userId={userId}
          onClose={() => setOpenTask(null)}
          onChanged={() => {
            setOpenTask(null);
            // přenačte Inbox (vlastní posluchač) i počítadlo — load() navíc
            // by znamenal druhé načtení téhož
            notifyTasksChanged();
          }}
        />
      )}
    </div>
  );
}
