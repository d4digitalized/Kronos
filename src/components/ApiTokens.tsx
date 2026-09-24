"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";
import { createApiToken } from "@/app/actions/tokens";
import { safeAction } from "@/lib/safeAction";

type Row = {
  id: string;
  name: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

function fmt(ts: string | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("cs-CZ", {
    day: "numeric",
    month: "numeric",
    year: "numeric",
  });
}

export default function ApiTokens() {
  const supabase = createClient();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("api_tokens")
      .select("id, name, last_used_at, revoked_at, created_at")
      .order("created_at", { ascending: false });
    setRows((data as Row[]) ?? []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    setCreating(true);
    const res = await safeAction(() => createApiToken(name));
    setCreating(false);
    if (res.error || !res.plain) {
      toast(res.error ?? "Token se nepodařilo vytvořit.", "error");
      return;
    }
    setFresh(res.plain);
    setName("");
    load();
  }

  async function revoke(id: string) {
    const { error } = await supabase
      .from("api_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id);
    if (error) {
      toast("Zrušení se nezdařilo.", "error");
      return;
    }
    load();
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Zkopírováno do schránky.", "success");
    } catch {
      toast("Kopírování se nezdařilo — zkopíruj token ručně.", "error");
    }
  }

  const mcpUrl =
    typeof window !== "undefined" ? `${window.location.origin}/api/mcp` : "/api/mcp";

  return (
    <div className="panel">
      <h2 className="border-b border-line/70 px-4 py-2.5 text-sm font-semibold">
        Napojení do Clauda (MCP)
      </h2>

      <div className="space-y-3 px-4 py-3">
        <p className="text-xs text-ink-soft/70">
          Vytvoř token a přidej ho do Clauda jako custom connector s adresou{" "}
          <code className="rounded bg-ink-soft/10 px-1 py-0.5">{mcpUrl}</code>. Claude
          pak umí pod tvým jménem procházet nástěnky, zakládat, dokončovat a přesouvat
          úkoly, přiřazovat řešitele i externí kontakty, nastavovat „Čekám na“,
          komentovat, měřit či vykazovat čas a zvát členy — jen v projektech a
          výkazech, které sám vidíš.
        </p>

        {fresh && (
          <div className="rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/5 p-3">
            <p className="text-xs font-medium">
              Nový token — zkopíruj ho teď, později už se nezobrazí:
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 overflow-x-auto whitespace-nowrap rounded bg-ink-soft/10 px-2 py-1 text-xs">
                {fresh}
              </code>
              <button
                onClick={() => copy(fresh)}
                className="btn-ghost shrink-0 px-2 py-1 text-xs"
              >
                Kopírovat
              </button>
              <button
                onClick={() => setFresh(null)}
                className="btn-ghost shrink-0 px-2 py-1 text-xs"
              >
                Hotovo
              </button>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Popisek (např. Claude web / mobil)"
            className="input flex-1 text-sm"
            onKeyDown={(e) => e.key === "Enter" && !creating && create()}
          />
          <button
            onClick={create}
            disabled={creating}
            className="btn-primary shrink-0 px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {creating ? "Vytvářím…" : "Vytvořit token"}
          </button>
        </div>
      </div>

      {loading ? (
        <p className="px-4 pb-3 text-xs text-ink-soft/70">Načítám…</p>
      ) : rows.length === 0 ? (
        <p className="px-4 pb-3 text-xs text-ink-soft/70">Zatím žádné tokeny.</p>
      ) : (
        <div className="divide-y divide-line/50 border-t border-line/70">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center gap-3 px-4 py-2.5">
              <span className="flex-1">
                <span className="block text-sm font-medium">
                  {r.name}
                  {r.revoked_at && (
                    <span className="ml-2 text-xs font-normal text-ink-soft/60">
                      (zrušen)
                    </span>
                  )}
                </span>
                <span className="block text-xs text-ink-soft/60">
                  vytvořen {fmt(r.created_at)} · naposledy použit{" "}
                  {fmt(r.last_used_at)}
                </span>
              </span>
              {!r.revoked_at && (
                <button
                  onClick={() => revoke(r.id)}
                  className="btn-ghost shrink-0 px-2 py-1 text-xs text-red-600"
                >
                  Zrušit
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
