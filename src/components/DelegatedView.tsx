"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { createClient } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";
import { pingNotifyEmails } from "@/lib/notify";
import { dayKey, fmtDate } from "@/lib/format";
import { cacheGet, cacheSet } from "@/lib/viewCache";
import { TASKS_CHANGED_EVENT } from "@/lib/tasksChanged";
import TaskRow, { TaskGroup } from "@/components/TaskRow";
import LoadError from "@/components/LoadError";
import type { Membership, Task, TaskFollowup } from "@/lib/types";
import { ListSkeleton } from "@/components/Skeletons";

// Modal se načte až při otevření karty — nezatěžuje základní bundle routy.
const CardModal = dynamic(() => import("@/components/CardModal"), { ssr: false });

const D_M = { day: "numeric", month: "numeric" } as const;
function short(date: string): string {
  return new Date(`${date}T00:00`).toLocaleDateString("cs-CZ", D_M);
}

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
// den v týdnu v lokativu podle Date.getDay() (0 = neděle)
const WEEKDAY = [
  "v neděli",
  "v pondělí",
  "v úterý",
  "ve středu",
  "ve čtvrtek",
  "v pátek",
  "v sobotu",
];

type WaitBucket = { key: string; label: string; rows: TaskFollowup[]; accent?: boolean };

/** Seskupení podle slíbeného termínu „do kdy" (waiting_until): po termínu,
    dnes, zítra, konkrétní den do konce týdne („v pátek"), příští týden,
    do měsíce, později; bez slíbeného data na konci. */
function waitBuckets(rows: TaskFollowup[]): WaitBucket[] {
  const now = new Date();
  const today = isoDay(now);
  const tomorrow = isoDay(addDays(now, 1));
  const sunday = addDays(now, (7 - now.getDay()) % 7); // nejbližší neděle
  const endOfWeek = isoDay(sunday);
  const endOfNextWeek = isoDay(addDays(sunday, 7));
  const monthAhead = isoDay(addDays(now, 31));

  const byKey = new Map<string, WaitBucket & { rank: number }>();
  const put = (
    key: string,
    label: string,
    rank: number,
    accent: boolean,
    r: TaskFollowup
  ) => {
    const g = byKey.get(key) ?? { key, label, rank, accent, rows: [] };
    g.rows.push(r);
    byKey.set(key, g);
  };

  for (const r of rows) {
    const until = r.waiting_until ?? null;
    if (!until) put("nodate", "Bez slíbeného termínu", 100, false, r);
    else if (until < today) put("overdue", "Po slíbeném termínu", 0, true, r);
    else if (until === today) put("today", "Slíbeno dnes", 1, false, r);
    else if (until === tomorrow) put("tomorrow", "Slíbeno zítra", 2, false, r);
    else if (until <= endOfWeek) {
      // do konce týdne — vlastní skupina pro každý den („Slíbeno v pátek")
      const d = new Date(`${until}T00:00`);
      const offset = Math.round(
        (d.getTime() - new Date(`${today}T00:00`).getTime()) / 86400000
      );
      put(`wd-${until}`, `Slíbeno ${WEEKDAY[d.getDay()]}`, 3 + offset, false, r);
    } else if (until <= endOfNextWeek)
      put("nextweek", "Slíbeno příští týden", 20, false, r);
    else if (until <= monthAhead) put("month", "Slíbeno do měsíce", 30, false, r);
    else put("later", "Slíbeno později", 40, false, r);
  }

  return [...byKey.values()].sort((a, b) => a.rank - b.rank);
}

export default function DelegatedView({
  wsId,
  userId,
}: {
  wsId: string;
  userId: string;
}) {
  const supabase = createClient();
  const cacheKey = `delegated:${wsId}:${userId}`;
  const cached = cacheGet<{ rows: TaskFollowup[]; members: Membership[] }>(cacheKey);
  const [rows, setRows] = useState<TaskFollowup[]>(cached?.rows ?? []);
  const [members, setMembers] = useState<Membership[]>(cached?.members ?? []);
  const [loading, setLoading] = useState(!cached);
  const [loadError, setLoadError] = useState(false);
  // pořadí načítání: starší odpověď nesmí přepsat novější
  const loadSeq = useRef(0);
  const [openTask, setOpenTask] = useState<Task | null>(null);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const [fuRes, memRes] = await Promise.all([
      supabase
        .from("task_followups")
        .select(
          "*, contacts(name), tasks!inner(*, projects(name, position), board_columns(name))"
        )
        .eq("created_by", userId)
        .eq("workspace_id", wsId)
        .is("tasks.completed_at", null),
      supabase
        .from("workspace_members")
        .select(
          "*, profiles(id, email, full_name, is_super_admin, avatar_initials, avatar_color, tag_name)"
        )
        .eq("workspace_id", wsId),
    ]);
    if (seq !== loadSeq.current) return;
    // chyba ≠ „na nikoho nečekáš": necháme, co je vidět, a nic necachujeme
    if (fuRes.error || memRes.error) {
      setLoading(false);
      setLoadError(true);
      return;
    }
    setLoadError(false);
    const list = ((fuRes.data ?? []) as unknown as TaskFollowup[]).sort(
      // nejdřív podle slíbeného termínu (do kdy), pak podle termínu úkolu
      (a, b) =>
        (a.waiting_until ?? a.tasks?.due_date ?? "9999").localeCompare(
          b.waiting_until ?? b.tasks?.due_date ?? "9999"
        ) || a.created_at.localeCompare(b.created_at)
    );
    const mem = (memRes.data as unknown as Membership[]) ?? [];
    setRows(list);
    setMembers(mem);
    cacheSet(cacheKey, { rows: list, members: mem });
    setLoading(false);
  }, [supabase, wsId, userId, cacheKey]);

  useEffect(() => {
    load();
    // změna follow-upu v otevřené kartě — přenačti seznam
    const onChanged = () => load();
    window.addEventListener(TASKS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(TASKS_CHANGED_EVENT, onChanged);
  }, [load]);

  function waitingName(row: TaskFollowup): string | null {
    if (row.waiting_user_id) {
      const m = members.find((x) => x.user_id === row.waiting_user_id);
      return m?.profiles?.full_name || m?.profiles?.email || "člen";
    }
    if (row.waiting_contact_id) return row.contacts?.name ?? "kontakt";
    return null; // čekání bez osoby (ruční přesun do Waiting on)
  }

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
    pingNotifyEmails();
    load();
  }

  if (loading) return <ListSkeleton />;
  // chyba a nic dřív načteného: hláška místo „Na nikoho nečekáš"
  if (loadError && rows.length === 0)
    return <LoadError onRetry={load} message="Follow-upy se nepodařilo načíst." />;

  // skupiny podle slíbeného termínu „do kdy" (rows už seřazené v load())
  const groups = waitBuckets(rows.filter((r) => r.tasks));

  return (
    <div className="w-full space-y-4">
      <div>
        <h1 className="font-display text-lg font-semibold">Čekám na</h1>
        <p className="text-xs text-ink-soft/70">
          {rows.length === 0
            ? "Na nikoho nečekáš."
            : `Čekáš na dodání ${rows.length} úkolů`}
        </p>
      </div>

      {loadError && (
        <LoadError onRetry={load} message="Follow-upy se nepodařilo obnovit." stale />
      )}

      {rows.length === 0 ? (
        <p className="panel p-8 text-center text-sm text-ink-soft/70">
          Na nikoho nečekáš. Follow-up nastavíš na kartě úkolu volbou „Čekám na…“.
        </p>
      ) : (
        groups.map((group) => (
          <TaskGroup
            key={group.key}
            label={group.label}
            count={group.rows.length}
            accent={group.accent}
          >
            {group.rows.map((row) => {
              // místní den — UTC by mezi půlnocí a 2:00 dal včerejšek
              const since = row.waiting_since ?? dayKey(row.created_at);
              const until = row.waiting_until ?? null;
              const today = dayKey(new Date().toISOString());
              const overdue = until && until < today;
              // o kolik dní je slíbený termín po termínu
              const overdueDays = overdue
                ? Math.round(
                    (new Date(`${today}T00:00`).getTime() -
                      new Date(`${until}T00:00`).getTime()) /
                      86400000
                  )
                : 0;
              const overdueText =
                overdueDays === 1
                  ? "1 den po termínu"
                  : overdueDays < 5
                    ? `${overdueDays} dny po termínu`
                    : `${overdueDays} dní po termínu`;
              return (
                <TaskRow
                  key={row.task_id}
                  task={row.tasks!}
                  onOpen={setOpenTask}
                  onToggleDone={toggleDone}
                  meta={
                    <span
                      className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${
                        overdue
                          ? "bg-danger/15 font-medium text-danger"
                          : "bg-amber-100 text-amber-800"
                      }`}
                      title={`Čeká od ${fmtDate(since)}${
                        until ? `, slíbeno do ${fmtDate(until)}` : ""
                      }`}
                    >
                      ⏳ {waitingName(row) ? `${waitingName(row)} · ` : ""}
                      od {short(since)}
                      {until ? ` do ${short(until)}` : ""}
                      {overdue ? ` · ${overdueText}` : ""}
                    </span>
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
