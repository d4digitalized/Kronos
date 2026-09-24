"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";
import { confirmDialog } from "@/lib/confirm";
import Avatar, { AVATAR_COLORS, avatarInitials } from "@/components/Avatar";
import type { Contact } from "@/lib/types";

/** Externí kontakty workspace — lidé bez účtu, na které lze delegovat úkoly
    (follow-up „Čekám na…" na kartě). Viz docs/CONCEPT-delegovane.md. */
export default function ContactsSection({ wsId }: { wsId: string }) {
  const supabase = createClient();
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  // inline editace
  const [editId, setEditId] = useState<string | null>(null);
  const [eName, setEName] = useState("");
  const [eEmail, setEEmail] = useState("");
  const [eNote, setENote] = useState("");
  const [eInitials, setEInitials] = useState("");
  const [eColor, setEColor] = useState("");

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("contacts")
      .select("*")
      .eq("workspace_id", wsId)
      .order("name");
    setContacts((data as Contact[]) ?? []);
  }, [supabase, wsId]);

  useEffect(() => {
    load();
  }, [load]);

  // Enter dvakrát = dva kontakty
  const adding = useRef(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n || adding.current) return;
    adding.current = true;
    const { error } = await supabase
      .from("contacts")
      .insert({ workspace_id: wsId, name: n, email: email.trim() });
    adding.current = false;
    if (error) {
      toast("Kontakt se nepodařilo založit.", "error");
      return;
    }
    setName("");
    setEmail("");
    load();
  }

  function startEdit(c: Contact) {
    setEditId(c.id);
    setEName(c.name);
    setEEmail(c.email);
    setENote(c.note);
    setEInitials(c.avatar_initials ?? "");
    setEColor(c.avatar_color ?? "");
  }

  async function saveEdit(id: string) {
    const n = eName.trim();
    if (!n) {
      toast("Jméno kontaktu nesmí být prázdné.", "error");
      return;
    }
    const { error } = await supabase
      .from("contacts")
      .update({
        name: n,
        email: eEmail.trim(),
        note: eNote.trim(),
        avatar_initials: eInitials.trim().toUpperCase().slice(0, 3),
        avatar_color: eColor,
      })
      .eq("id", id);
    if (error) {
      toast("Uložení kontaktu se nezdařilo.", "error");
      return;
    }
    setEditId(null);
    toast("Kontakt uložen.");
    load();
  }

  async function remove(c: Contact) {
    const ok = await confirmDialog({
      title: "Smazat kontakt?",
      message: `Kontakt „${c.name}" se smaže a zruší se i čekání na něj na všech kartách.`,
      confirmLabel: "Smazat",
    });
    if (!ok) return;
    const { error } = await supabase.from("contacts").delete().eq("id", c.id);
    if (error) {
      toast("Smazání se nezdařilo.", "error");
      return;
    }
    load();
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="font-display text-base font-semibold">Externí kontakty</h2>
        <p className="text-xs text-ink-soft/70">
          Lidé bez účtu, na které lze delegovat úkoly („Čekám na…“ na kartě).
          Se systémem nijak neinteragují.
        </p>
      </div>

      <form onSubmit={add} className="flex flex-wrap items-center gap-2 panel p-3">
        <input
          type="text"
          required
          placeholder="Jméno kontaktu"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-40 flex-1 input"
        />
        <input
          type="email"
          placeholder="E-mail (nepovinný)"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="min-w-40 flex-1 input"
        />
        <button type="submit" className="btn-primary">
          Přidat
        </button>
      </form>

      {contacts === null ? (
        <p className="p-2 text-sm text-ink-soft/70">Načítám…</p>
      ) : contacts.length === 0 ? (
        <p className="panel p-4 text-sm text-ink-soft/70">
          Zatím žádné kontakty.
        </p>
      ) : (
        <div className="divide-y divide-line/70 panel">
          {contacts.map((c) => (
            <div key={c.id}>
              <div className="flex items-center gap-3 px-3 py-2">
                <Avatar
                  profile={{
                    full_name: c.name,
                    avatar_initials: c.avatar_initials || null,
                    avatar_color: c.avatar_color || "#9ca3af",
                  }}
                  colorKey={c.id}
                  size="md"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{c.name}</p>
                  <p className="truncate text-xs text-ink-soft/70">
                    {c.email || "bez e-mailu"}
                    {c.note ? ` · ${c.note}` : ""}
                  </p>
                </div>
                <button
                  onClick={() => (editId === c.id ? setEditId(null) : startEdit(c))}
                  aria-expanded={editId === c.id}
                  className={`rounded-md px-2 py-1 text-xs hover:bg-black/5 ${
                    editId === c.id ? "bg-accent-soft text-accent" : "text-ink-soft"
                  }`}
                >
                  Upravit
                </button>
                <button
                  onClick={() => remove(c)}
                  className="rounded-md px-2 py-1 text-xs text-danger hover:bg-danger/10"
                >
                  Smazat
                </button>
              </div>

              {editId === c.id && (
                <div className="space-y-2 border-t border-line/50 bg-black/[.015] px-3 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Avatar
                      profile={{
                        full_name: eName,
                        avatar_initials: eInitials,
                        avatar_color: eColor || "#9ca3af",
                      }}
                      colorKey={c.id}
                      size="lg"
                    />
                    <input
                      type="text"
                      value={eName}
                      onChange={(e) => setEName(e.target.value)}
                      placeholder="Jméno"
                      aria-label="Jméno kontaktu"
                      className="min-w-36 flex-1 input"
                    />
                    <input
                      type="text"
                      value={eInitials}
                      onChange={(e) => setEInitials(e.target.value)}
                      maxLength={3}
                      placeholder={avatarInitials({ full_name: eName })}
                      aria-label="Iniciály (max 3 znaky)"
                      title="Iniciály — prázdné se odvodí ze jména"
                      className="input w-16 text-center uppercase"
                    />
                    <input
                      type="email"
                      value={eEmail}
                      onChange={(e) => setEEmail(e.target.value)}
                      placeholder="E-mail"
                      aria-label="E-mail kontaktu"
                      className="min-w-36 flex-1 input"
                    />
                    <input
                      type="text"
                      value={eNote}
                      onChange={(e) => setENote(e.target.value)}
                      placeholder="Poznámka (firma, role…)"
                      aria-label="Poznámka"
                      className="min-w-36 flex-1 input"
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-ink-soft/70">Barva:</span>
                    {AVATAR_COLORS.map((color) => (
                      <button
                        key={color}
                        onClick={() => setEColor(color)}
                        aria-label={`Barva ${color}`}
                        aria-pressed={eColor === color}
                        style={{ background: color }}
                        className={`h-6 w-6 rounded-full transition-transform ${
                          eColor === color
                            ? "scale-110 ring-2 ring-ink ring-offset-1"
                            : "hover:scale-105"
                        }`}
                      />
                    ))}
                    <input
                      type="color"
                      value={eColor || "#9ca3af"}
                      onChange={(e) => setEColor(e.target.value)}
                      aria-label="Vlastní barva"
                      title="Vlastní barva"
                      className="h-6 w-8 cursor-pointer rounded border border-line bg-transparent"
                    />
                    {eColor && (
                      <button
                        onClick={() => setEColor("")}
                        className="btn-ghost px-2 py-0.5 text-xs"
                      >
                        Automatická (šedá)
                      </button>
                    )}
                    <span className="flex-1" />
                    <button
                      onClick={() => setEditId(null)}
                      className="btn-ghost px-2 py-1 text-xs"
                    >
                      Zrušit
                    </button>
                    <button
                      onClick={() => saveEdit(c.id)}
                      className="btn-primary px-3 py-1 text-xs"
                    >
                      Uložit
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
