"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";
import type { Workspace } from "@/lib/types";

export default function WorkspacesAdmin() {
  const supabase = createClient();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const { data } = await supabase.from("workspaces").select("*").order("name");
    setWorkspaces((data as Workspace[]) ?? []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  // Enter dvakrát = dvě firmy
  const adding = useRef(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name || adding.current) return;
    adding.current = true;
    setNewName("");
    const { error } = await supabase.from("workspaces").insert({ name });
    adding.current = false;
    if (error) {
      setNewName(name);
      toast("Firmu se nepodařilo založit.", "error");
      return;
    }
    load();
  }

  async function rename(ws: Workspace) {
    if (editName.trim() && editName.trim() !== ws.name) {
      await supabase.from("workspaces").update({ name: editName.trim() }).eq("id", ws.id);
    }
    setEditingId(null);
    load();
  }

  if (loading) return <p className="p-4 text-ink-soft/70">Načítám…</p>;

  return (
    <div className="space-y-4">
      <form
        onSubmit={add}
        className="flex gap-2 panel p-3"
      >
        <input
          type="text"
          placeholder="Název nové firmy / workspace…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          className="flex-1 input"
        />
        <button
          type="submit"
          className="btn-primary"
        >
          Založit
        </button>
      </form>

      <div className="divide-y divide-line/70 panel">
        {workspaces.length === 0 && (
          <p className="p-4 text-sm text-ink-soft/70">Zatím žádné workspaces.</p>
        )}
        {workspaces.map((ws) => (
          <div key={ws.id} className="flex items-center gap-2 px-3 py-2">
            {editingId === ws.id ? (
              <>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="flex-1 input px-2 py-1"
                  autoFocus
                />
                <button
                  onClick={() => rename(ws)}
                  className="btn-primary px-2 py-1 text-xs"
                >
                  Uložit
                </button>
              </>
            ) : (
              <>
                <span className="flex-1 text-sm font-medium">{ws.name}</span>
                <Link
                  href={`/w/${ws.id}`}
                  className="rounded-md px-2 py-1 text-xs text-ink-soft hover:bg-black/5"
                >
                  Otevřít
                </Link>
                <Link
                  href={`/w/${ws.id}/members`}
                  className="rounded-md px-2 py-1 text-xs text-ink-soft hover:bg-black/5"
                >
                  Členové
                </Link>
                <button
                  onClick={() => {
                    setEditingId(ws.id);
                    setEditName(ws.name);
                  }}
                  className="rounded-md px-2 py-1 text-xs text-ink-soft hover:bg-black/5"
                >
                  Přejmenovat
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
