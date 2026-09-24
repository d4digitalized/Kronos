"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";
import { confirmDialog } from "@/lib/confirm";
import type { Checklist, ChecklistItem } from "@/lib/types";

type ItemsByList = Record<string, ChecklistItem[]>;

export default function CardChecklists({
  taskId,
  workspaceId,
}: {
  taskId: string;
  workspaceId: string;
}) {
  const supabase = createClient();
  const [lists, setLists] = useState<Checklist[]>([]);
  const [items, setItems] = useState<ItemsByList>({});
  const [newItem, setNewItem] = useState<Record<string, string>>({});
  const [newList, setNewList] = useState("");
  const [adding, setAdding] = useState(false);
  // rozběhnuté přidání — druhý Enter by založil stejný záznam znovu
  const addingList = useRef(false);
  const addingItem = useRef(false);

  const load = useCallback(async () => {
    // seznamy i jejich položky jedním dotazem (dřív dva za sebou a chyba
    // druhého se tiše spolkla — seznamy pak vypadaly prázdné)
    const { data, error } = await supabase
      .from("checklists")
      .select("*, checklist_items(*)")
      .eq("task_id", taskId)
      .order("position")
      .order("created_at")
      .order("position", { referencedTable: "checklist_items" })
      .order("created_at", { referencedTable: "checklist_items" });
    // chyba ≠ prázdné seznamy — necháme, co je vidět
    if (error) return;
    const rows = (data ?? []) as (Checklist & { checklist_items: ChecklistItem[] | null })[];
    const byList: ItemsByList = {};
    for (const row of rows) byList[row.id] = row.checklist_items ?? [];
    setLists(
      rows.map((row) => ({
        id: row.id,
        workspace_id: row.workspace_id,
        task_id: row.task_id,
        title: row.title,
        position: row.position,
        created_at: row.created_at,
      }))
    );
    setItems(byList);
  }, [supabase, taskId]);

  useEffect(() => {
    load();
  }, [load]);

  async function addList(e: React.FormEvent) {
    e.preventDefault();
    if (addingList.current) return;
    addingList.current = true;
    const typed = newList;
    const title = newList.trim() || "Seznam";
    // formulář hned zavřít — při chybě se vrátí i s textem
    setNewList("");
    setAdding(false);
    const { error } = await supabase.from("checklists").insert({
      workspace_id: workspaceId,
      task_id: taskId,
      title,
      position: lists.length,
    });
    addingList.current = false;
    if (error) {
      toast("Seznam se nepodařilo přidat.", "error");
      setNewList((cur) => cur || typed);
      setAdding(true);
      return;
    }
    load();
  }

  async function renameList(list: Checklist, title: string) {
    const next = title.trim();
    if (!next || next === list.title) return;
    await supabase.from("checklists").update({ title: next }).eq("id", list.id);
    load();
  }

  async function removeList(list: Checklist) {
    const ok = await confirmDialog({
      title: "Smazat seznam?",
      message: `Seznam „${list.title}" se smaže včetně položek.`,
    });
    if (!ok) return;
    await supabase.from("checklists").delete().eq("id", list.id);
    load();
  }

  async function addItem(listId: string, e: React.FormEvent) {
    e.preventDefault();
    const content = (newItem[listId] ?? "").trim();
    if (!content || addingItem.current) return;
    addingItem.current = true;
    setNewItem((p) => ({ ...p, [listId]: "" })); // hned prázdné — při chybě zpět
    const { error } = await supabase.from("checklist_items").insert({
      checklist_id: listId,
      content,
      position: (items[listId] ?? []).length,
    });
    addingItem.current = false;
    if (error) {
      toast("Položku se nepodařilo přidat.", "error");
      setNewItem((p) => ({ ...p, [listId]: p[listId] || content }));
      return;
    }
    load();
  }

  async function toggleItem(item: ChecklistItem) {
    await supabase
      .from("checklist_items")
      .update({
        completed_at: item.completed_at ? null : new Date().toISOString(),
      })
      .eq("id", item.id);
    load();
  }

  async function removeItem(item: ChecklistItem) {
    await supabase.from("checklist_items").delete().eq("id", item.id);
    load();
  }

  return (
    <div className="space-y-3 border-t border-line/70 pt-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">Seznamy</h3>
        <span className="flex-1" />
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            className="rounded-md px-2 py-0.5 text-xs text-ink-soft/80 hover:bg-black/5"
          >
            + Přidat seznam
          </button>
        )}
      </div>

      {adding && (
        <form onSubmit={addList} className="flex gap-2">
          <input
            autoFocus
            type="text"
            value={newList}
            onChange={(e) => setNewList(e.target.value)}
            onBlur={() => !newList.trim() && setAdding(false)}
            placeholder="Název seznamu…"
            className="input flex-1 px-2 py-1 text-sm"
          />
          <button type="submit" className="btn-primary px-3 py-1 text-sm">
            OK
          </button>
        </form>
      )}

      {lists.map((list) => {
        const its = items[list.id] ?? [];
        const done = its.filter((i) => i.completed_at).length;
        const pct = its.length ? Math.round((done / its.length) * 100) : 0;
        return (
          <div key={list.id} className="space-y-1.5">
            <div className="flex items-center gap-2">
              <input
                defaultValue={list.title}
                onBlur={(e) => renameList(list, e.target.value)}
                aria-label="Název seznamu"
                className="min-w-0 flex-1 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium hover:border-line focus:border-line"
              />
              <span className="shrink-0 text-xs text-ink-soft/60">
                {done}/{its.length}
              </span>
              <button
                onClick={() => removeList(list)}
                aria-label={`Smazat seznam ${list.title}`}
                className="shrink-0 rounded px-1.5 text-xs text-ink-soft/50 hover:text-danger"
              >
                ×
              </button>
            </div>

            {its.length > 0 && (
              <div className="h-1 overflow-hidden rounded-full bg-black/5">
                <div
                  className="h-full rounded-full bg-accent transition-[width]"
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}

            {its.map((item) => (
              <div key={item.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={!!item.completed_at}
                  onChange={() => toggleItem(item)}
                  className="h-3.5 w-3.5"
                />
                <span
                  className={`flex-1 text-sm ${
                    item.completed_at ? "text-ink-soft/70 line-through" : ""
                  }`}
                >
                  {item.content}
                </span>
                <button
                  onClick={() => removeItem(item)}
                  aria-label={`Smazat položku ${item.content}`}
                  className="rounded px-1.5 text-xs text-ink-soft/50 hover:text-danger"
                >
                  ×
                </button>
              </div>
            ))}

            <form onSubmit={(e) => addItem(list.id, e)} className="flex gap-2">
              <input
                type="text"
                placeholder="+ Přidat položku…"
                value={newItem[list.id] ?? ""}
                onChange={(e) =>
                  setNewItem((p) => ({ ...p, [list.id]: e.target.value }))
                }
                className="input-quiet flex-1 px-2 py-1 text-sm"
              />
              {(newItem[list.id] ?? "").trim() && (
                <button type="submit" className="btn-primary px-2 py-0.5 text-xs">
                  OK
                </button>
              )}
            </form>
          </div>
        );
      })}
    </div>
  );
}
