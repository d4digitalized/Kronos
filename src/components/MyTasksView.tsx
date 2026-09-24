"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { createClient } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";
import { pingNotifyEmails } from "@/lib/notify";
import { cacheGet, cacheSet } from "@/lib/viewCache";
import { TASKS_CHANGED_EVENT } from "@/lib/tasksChanged";
import TaskRow, { TaskGroup, dueBuckets } from "@/components/TaskRow";
import Avatar, { type AvatarLike } from "@/components/Avatar";
import LoadError from "@/components/LoadError";
import type { Contact, Membership, Task } from "@/lib/types";
import { ListSkeleton } from "@/components/Skeletons";

// Modal se načte až při otevření karty — nezatěžuje základní bundle routy.
const CardModal = dynamic(() => import("@/components/CardModal"), { ssr: false });

export default function MyTasksView({
  wsId,
  userId,
  heading,
  profile,
}: {
  wsId: string;
  userId: string;
  heading: string;
  profile: AvatarLike | null;
}) {
  const supabase = createClient();
  const cacheKey = `mytasks:${wsId}:${userId}`;
  const cached = cacheGet<{
    tasks: Task[];
    members: Membership[];
    leadTasks: Task[];
    leadAssignees: Record<string, string[]>;
    leadGhosts: Record<string, Contact[]>;
  }>(cacheKey);
  const [tasks, setTasks] = useState<Task[]>(cached?.tasks ?? []);
  const [members, setMembers] = useState<Membership[]>(cached?.members ?? []);
  // úkoly, kde jsem vedoucí — druhá záložka přepínače
  const [leadTasks, setLeadTasks] = useState<Task[]>(cached?.leadTasks ?? []);
  const [leadAssignees, setLeadAssignees] = useState<Record<string, string[]>>(
    cached?.leadAssignees ?? {}
  );
  // externí řešitelé (duchové) vedených úkolů
  const [leadGhosts, setLeadGhosts] = useState<Record<string, Contact[]>>(
    cached?.leadGhosts ?? {}
  );
  const [mode, setMode] = useState<"mine" | "lead">("mine");
  const [loading, setLoading] = useState(!cached);
  const [loadError, setLoadError] = useState(false);
  // pořadí načítání: starší odpověď nesmí přepsat novější
  const loadSeq = useRef(0);
  const [openTask, setOpenTask] = useState<Task | null>(null);

  const byDue = (a: Task, b: Task) =>
    (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999") ||
    (a.priority ?? 4) - (b.priority ?? 4) ||
    a.title.localeCompare(b.title, "cs");

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const [mineRes, memRes, fuRes, leadRes] = await Promise.all([
      supabase
        .from("task_assignees")
        .select(
          "tasks!inner(*, projects(name, position), board_columns(name))"
        )
        .eq("user_id", userId)
        .eq("tasks.workspace_id", wsId)
        .is("tasks.completed_at", null)
        .is("tasks.parent_id", null),
      supabase
        .from("workspace_members")
        .select(
          "*, profiles(id, email, full_name, is_super_admin, avatar_initials, avatar_color, tag_name)"
        )
        .eq("workspace_id", wsId),
      // úkoly, kde jsem nastavil follow-up, žijí na stránce Delegované
      supabase
        .from("task_followups")
        .select("task_id")
        .eq("created_by", userId)
        .eq("workspace_id", wsId),
      supabase
        .from("tasks")
        .select(
          "*, projects(name, position), board_columns(name), task_assignees(user_id), task_contact_assignees(contacts(*))"
        )
        .eq("workspace_id", wsId)
        .eq("lead_id", userId)
        .is("completed_at", null)
        .is("parent_id", null),
    ]);
    if (seq !== loadSeq.current) return;
    // chyba ≠ „žádné úkoly": necháme, co je vidět, a nic necachujeme
    if (mineRes.error || memRes.error || fuRes.error || leadRes.error) {
      setLoading(false);
      setLoadError(true);
      return;
    }
    setLoadError(false);
    const waiting = new Set((fuRes.data ?? []).map((r) => r.task_id as string));
    const mine = ((mineRes.data ?? []) as unknown as { tasks: Task }[])
      .map((r) => r.tasks)
      // bez follow-upů (žijí v „Čekám na"), uspaných karet (Hold)
      // a bez nezatříděných úkolů — ty čekají v Inboxu
      .filter(
        (t) =>
          !waiting.has(t.id) &&
          !t.on_hold &&
          !(!t.project_id && t.created_by === userId && !t.triaged_at)
      )
      .sort(byDue);
    const leadRows = ((leadRes.data ?? []) as unknown as (Task & {
      task_assignees?: { user_id: string }[];
      task_contact_assignees?: { contacts: Contact | null }[];
    })[])
      .filter((t) => !t.on_hold) // uspané karty spí i pro vedoucího
      .sort(byDue);
    const leadByTask: Record<string, string[]> = {};
    const ghostsByTask: Record<string, Contact[]> = {};
    for (const t of leadRows) {
      leadByTask[t.id] = (t.task_assignees ?? []).map((a) => a.user_id);
      ghostsByTask[t.id] = (t.task_contact_assignees ?? [])
        .map((g) => g.contacts)
        .filter((c): c is Contact => !!c);
    }
    const mem = (memRes.data as unknown as Membership[]) ?? [];
    setTasks(mine);
    setMembers(mem);
    setLeadTasks(leadRows);
    setLeadAssignees(leadByTask);
    setLeadGhosts(ghostsByTask);
    cacheSet(cacheKey, {
      tasks: mine,
      members: mem,
      leadTasks: leadRows,
      leadAssignees: leadByTask,
      leadGhosts: ghostsByTask,
    });
    setLoading(false);
  }, [supabase, wsId, userId, cacheKey]);

  useEffect(() => {
    load();
    // nový úkol z plovoucího „+" v layoutu — přenačti seznam
    const onChanged = () => load();
    window.addEventListener(TASKS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(TASKS_CHANGED_EVENT, onChanged);
  }, [load]);

  async function toggleDone(task: Task) {
    const { error } = await supabase
      .from("tasks")
      .update({ completed_at: new Date().toISOString() })
      .eq("id", task.id);
    if (error) {
      toast("Uložení se nezdařilo.", "error");
      return;
    }
    toast(`Hotovo: ${task.title}`);
    pingNotifyEmails(); // opakovaná karta může přiřadit další výskyt
    load();
  }

  if (loading) return <ListSkeleton />;
  // chyba a nic dřív načteného: hláška místo „Nemáš žádné otevřené úkoly"
  if (loadError && tasks.length === 0 && leadTasks.length === 0)
    return <LoadError onRetry={load} message="Úkoly se nepodařilo načíst." />;

  const shown = mode === "mine" ? tasks : leadTasks;
  const groups = dueBuckets(shown);

  return (
    <div className="w-full space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Avatar profile={profile} colorKey={userId} size="lg" />
        <div>
          <h1 className="font-display text-lg font-semibold">{heading}</h1>
          <p className="text-xs text-ink-soft/70">
            {shown.length === 0
              ? "Žádné otevřené úkoly."
              : `${shown.length} otevřených úkolů`}
          </p>
        </div>
        {/* přepínač se ukáže, jen když někde vedu — jinak je záložka k ničemu */}
        {leadTasks.length > 0 && (
          <div className="ml-auto inline-flex rounded-lg bg-black/5 p-0.5 text-sm">
            {(
              [
                ["mine", "Moje", tasks.length],
                ["lead", "Vedu", leadTasks.length],
              ] as const
            ).map(([key, label, count]) => (
              <button
                key={key}
                onClick={() => setMode(key)}
                aria-pressed={mode === key}
                className={`rounded-md px-3 py-1 transition-colors ${
                  mode === key
                    ? "bg-surface font-medium text-ink shadow-sm"
                    : "text-ink-soft hover:text-ink"
                }`}
              >
                {label}
                <span className="ml-1.5 text-xs text-ink-soft/60">{count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {loadError && (
        <LoadError onRetry={load} message="Úkoly se nepodařilo obnovit." stale />
      )}

      {shown.length === 0 ? (
        <p className="panel p-8 text-center text-sm text-ink-soft/70">
          {mode === "mine"
            ? "Nemáš žádné otevřené úkoly. 🎉"
            : "Nevedeš žádný otevřený úkol."}
        </p>
      ) : (
        groups.map((group) => (
          <TaskGroup
            key={group.key}
            label={group.label}
            count={group.tasks.length}
            accent={group.accent}
          >
            {group.tasks.map((task) => {
              // u vedených úkolů ukaž, kdo na nich reálně dělá — členy i duchy
              const rowAssignees =
                mode === "lead"
                  ? (leadAssignees[task.id] ?? [])
                      .map((id) => members.find((m) => m.user_id === id))
                      .filter((m): m is Membership => !!m)
                  : [];
              const rowGhosts = mode === "lead" ? (leadGhosts[task.id] ?? []) : [];
              return (
                <TaskRow
                  key={task.id}
                  task={task}
                  onOpen={setOpenTask}
                  onToggleDone={toggleDone}
                  meta={
                    (rowAssignees.length > 0 || rowGhosts.length > 0) && (
                      <span className="flex flex-wrap items-center gap-1.5">
                        {rowAssignees.map((m) => (
                          <span
                            key={m.user_id}
                            className="inline-flex items-center gap-1.5 rounded-full bg-black/5 py-0.5 pl-0.5 pr-2 text-xs text-ink-soft"
                          >
                            <Avatar
                              profile={m.profiles}
                              colorKey={m.user_id}
                              size="xs"
                            />
                            {m.profiles?.full_name || m.profiles?.email}
                          </span>
                        ))}
                        {rowGhosts.map((c) => (
                          <span
                            key={c.id}
                            title={`${c.name} (externí)`}
                            className="inline-flex items-center gap-1.5 rounded-full bg-black/5 py-0.5 pl-0.5 pr-2 text-xs text-ink-soft"
                          >
                            <Avatar
                              profile={{
                                full_name: c.name,
                                avatar_initials: c.avatar_initials || null,
                                avatar_color: c.avatar_color || "#9ca3af",
                              }}
                              colorKey={c.id}
                              size="xs"
                            />
                            {c.name}
                          </span>
                        ))}
                      </span>
                    )
                  }
                />
              );
            })}
          </TaskGroup>
        ))
      )}

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
