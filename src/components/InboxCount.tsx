"use client";

import { useCallback, useSyncExternalStore } from "react";
import { createClient } from "@/lib/supabase/client";
import { TASKS_CHANGED_EVENT } from "@/lib/tasksChanged";

/** Sdílený stav počítadla pro jednu firmu a uživatele. InboxCount je
    v navigaci připojený víckrát (Sidebar, tab-bar i menu v MobileNav) —
    dřív načítala každá instance sama; teď sdílí jedno načtení a jednoho
    posluchače změn úkolů. */
type CountStore = {
  wsId: string;
  userId: string;
  count: number;
  listeners: Set<() => void>;
  inFlight: Promise<void> | null;
  /** pořadí načítání: starší odpověď nesmí přepsat novější */
  seq: number;
  onTasksChanged: () => void;
};

const stores = new Map<string, CountStore>();

function getStore(wsId: string, userId: string): CountStore {
  const key = `${wsId}:${userId}`;
  const existing = stores.get(key);
  if (existing) return existing;
  const store: CountStore = {
    wsId,
    userId,
    count: 0,
    listeners: new Set(),
    inFlight: null,
    seq: 0,
    // jedno přenačtení na změnu úkolů, ať je instancí kolik chce
    onTasksChanged: () => refresh(store),
  };
  stores.set(key, store);
  return store;
}

function refresh(store: CountStore) {
  const run = fetchCount(store).finally(() => {
    if (store.inFlight === run) store.inFlight = null;
  });
  store.inFlight = run;
}

async function fetchCount(store: CountStore) {
  const { wsId, userId } = store;
  const seq = ++store.seq;
  const supabase = createClient();
  const [tRes, fuRes] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, task_assignees(user_id), task_contact_assignees(contact_id)")
      .eq("workspace_id", wsId)
      .eq("created_by", userId)
      .is("project_id", null)
      .is("completed_at", null)
      .is("parent_id", null)
      .is("triaged_at", null),
    supabase
      .from("task_followups")
      .select("task_id")
      .eq("workspace_id", wsId)
      .eq("created_by", userId),
  ]);
  if (seq !== store.seq) return;
  // chyba ≠ „nic k roztřídění": nechat poslední známé číslo
  if (tRes.error || fuRes.error) return;
  const waiting = new Set((fuRes.data ?? []).map((r) => r.task_id as string));
  const rows = (tRes.data ?? []) as {
    id: string;
    task_assignees: { user_id: string }[];
    task_contact_assignees: unknown[];
  }[];
  // stejné pravidlo jako InboxView: úkol jen pro mě je pořád nezatříděný
  store.count = rows.filter(
    (t) =>
      (t.task_assignees ?? []).every((a) => a.user_id === userId) &&
      (t.task_contact_assignees ?? []).length === 0 &&
      !waiting.has(t.id)
  ).length;
  store.listeners.forEach((notify) => notify());
}

function subscribe(store: CountStore, onChange: () => void) {
  store.listeners.add(onChange);
  if (store.listeners.size === 1) {
    window.addEventListener(TASKS_CHANGED_EVENT, store.onTasksChanged);
    // první instance načte; další (i StrictMode remount) sdílí rozjeté načtení
    if (!store.inFlight) refresh(store);
  }
  return () => {
    store.listeners.delete(onChange);
    if (store.listeners.size === 0)
      window.removeEventListener(TASKS_CHANGED_EVENT, store.onTasksChanged);
  };
}

/** Živé počítadlo nezatříděných úkolů v Inboxu (viz InboxView: moje otevřené
    úkoly bez projektu, bez řešitele a bez follow-upu). Nula = nic nesvědí. */
export default function InboxCount({
  wsId,
  userId,
}: {
  wsId: string;
  userId: string;
}) {
  const subscribeStore = useCallback(
    (onChange: () => void) => subscribe(getStore(wsId, userId), onChange),
    [wsId, userId]
  );
  const count = useSyncExternalStore(
    subscribeStore,
    () => stores.get(`${wsId}:${userId}`)?.count ?? 0,
    () => 0
  );

  if (count === 0) return null;
  return (
    <span className="ml-auto rounded-full bg-accent/15 px-1.5 py-px text-[11px] font-medium text-accent">
      {count}
    </span>
  );
}
