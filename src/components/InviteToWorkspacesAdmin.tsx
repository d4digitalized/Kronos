"use client";

import { useEffect, useState, useTransition } from "react";
import { createClient } from "@/lib/supabase/client";
import { inviteToWorkspaces } from "@/app/actions/members";
import { safeAction } from "@/lib/safeAction";
import type { Role, Workspace } from "@/lib/types";

export default function InviteToWorkspacesAdmin() {
  const supabase = createClient();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    supabase
      .from("workspaces")
      .select("*")
      .order("name")
      .then(({ data }) => setWorkspaces((data as Workspace[]) ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle(wsId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(wsId)) next.delete(wsId);
      else next.add(wsId);
      return next;
    });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    startTransition(async () => {
      // výjimka uvnitř transition by shodila stránku na chybovou hranici
      const result = await safeAction(() => inviteToWorkspaces(email, role, [...selected]));
      if (result.error) {
        setMessage(result.error);
        return;
      }
      const parts = [
        result.invited
          ? `Pozvánka odeslána na ${email.trim()}.`
          : "Účet už existoval, přidán bez e-mailu.",
        `Přidán do ${result.added} firem.`,
      ];
      if (result.alreadyMember)
        parts.push(`V ${result.alreadyMember} už členem byl.`);
      if (result.failed) parts.push(`${result.failed} se nezdařilo.`);
      setMessage(parts.join(" "));
      setEmail("");
      setSelected(new Set());
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3 panel p-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="email"
          required
          placeholder="email@firma.cz"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="min-w-48 flex-1 input"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          aria-label="Role"
          className="input px-2"
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
      </div>

      <fieldset>
        <legend className="pb-1 text-sm font-medium">
          Firmy ({selected.size} vybráno)
        </legend>
        <div className="grid gap-1 sm:grid-cols-2">
          {workspaces.map((ws) => (
            <label
              key={ws.id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-black/5"
            >
              <input
                type="checkbox"
                checked={selected.has(ws.id)}
                onChange={() => toggle(ws.id)}
                className="accent-[var(--accent)]"
              />
              <span className="truncate">{ws.name}</span>
            </label>
          ))}
        </div>
        {workspaces.length > 1 && (
          <button
            type="button"
            onClick={() =>
              setSelected((prev) =>
                prev.size === workspaces.length
                  ? new Set()
                  : new Set(workspaces.map((w) => w.id))
              )
            }
            className="mt-1 text-xs text-accent hover:underline"
          >
            {selected.size === workspaces.length ? "Zrušit výběr" : "Vybrat vše"}
          </button>
        )}
      </fieldset>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending || selected.size === 0}
          className="btn-primary"
        >
          {pending ? "Přidávám…" : "Pozvat do vybraných firem"}
        </button>
        {message && <p className="text-sm text-ink-soft">{message}</p>}
      </div>
    </form>
  );
}
