"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  inviteMember,
  listAddablePortalUsers,
  listAllUsers,
  setMemberFlag,
  setMemberNotifyEmail,
  type AppUser,
} from "@/app/actions/members";
import Picker from "@/components/Picker";
import Avatar, { AVATAR_COLORS, avatarInitials } from "@/components/Avatar";
import ContactsSection from "@/components/ContactsSection";
import { toast } from "@/lib/toast";
import { safeAction } from "@/lib/safeAction";
import { confirmDialog } from "@/lib/confirm";
import type { Membership, Role } from "@/lib/types";
import { ListSkeleton } from "@/components/Skeletons";

const USER_ICON =
  "M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M9.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z";

type PortalUser = { id: string; email: string; full_name: string };

export default function MembersView({
  wsId,
  currentUserId,
  isSuperAdmin,
}: {
  wsId: string;
  currentUserId: string;
  isSuperAdmin: boolean;
}) {
  const supabase = createClient();
  const [members, setMembers] = useState<Membership[]>([]);
  const [mode, setMode] = useState<"portal" | "email">("portal");
  const [email, setEmail] = useState("");
  const [pickedUserId, setPickedUserId] = useState<string | null>(null);
  const [portalUsers, setPortalUsers] = useState<PortalUser[]>([]);
  const [role, setRole] = useState<Role>("member");
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, startTransition] = useTransition();
  // přepínač seznamu: členové této firmy × všichni uživatelé aplikace (jen super-admin)
  const [tab, setTab] = useState<"workspace" | "all">("workspace");
  const [allUsers, setAllUsers] = useState<AppUser[] | null>(null);
  const [allLoading, setAllLoading] = useState(false);
  const [allError, setAllError] = useState<string | null>(null);
  // admin editace profilu člena (jméno, iniciály, barva)
  const [editId, setEditId] = useState<string | null>(null);
  const [eName, setEName] = useState("");
  const [eInitials, setEInitials] = useState("");
  const [eColor, setEColor] = useState("");
  const [eTag, setETag] = useState("");

  const load = useCallback(async () => {
    const [{ data, error }, addable] = await Promise.all([
      supabase
        .from("workspace_members")
        .select(
          "*, profiles(id, email, full_name, is_super_admin, avatar_initials, avatar_color, tag_name)"
        )
        .eq("workspace_id", wsId)
        .order("role"),
      // bez safeAction by selhaná akce (stará záložka) nechala skeleton navždy
      safeAction(() => listAddablePortalUsers(wsId)),
    ]);
    setLoading(false);
    // chyba ≠ „žádní členové" — nechat, co je vidět
    if (error) {
      toast("Členy se nepodařilo načíst.", "error");
      return;
    }
    setMembers((data as unknown as Membership[]) ?? []);
    setPortalUsers(addable.users ?? []);
  }, [supabase, wsId]);

  useEffect(() => {
    load();
  }, [load]);

  const loadAll = useCallback(async () => {
    setAllLoading(true);
    setAllError(null);
    const result = await safeAction(() => listAllUsers());
    if (result.error) setAllError(result.error);
    else setAllUsers(result.users ?? []);
    setAllLoading(false);
  }, []);

  useEffect(() => {
    if (tab === "all" && allUsers === null && !allLoading) loadAll();
  }, [tab, allUsers, allLoading, loadAll]);

  function invite(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    const targetEmail =
      mode === "portal"
        ? portalUsers.find((u) => u.id === pickedUserId)?.email
        : email;
    if (!targetEmail) {
      setMessage(mode === "portal" ? "Vyber uživatele." : "Zadej e-mail.");
      return;
    }
    startTransition(async () => {
      // výjimka uvnitř transition by shodila stránku na chybovou hranici
      const result = await safeAction(() => inviteMember(wsId, targetEmail, role));
      setMessage(
        result.error ??
          (result.invited
            ? `Pozvánka odeslána na ${targetEmail.trim()}. Po nastavení hesla se tu objeví.`
            : "Člen přidán.")
      );
      if (result.ok) {
        setEmail("");
        setPickedUserId(null);
        load();
      }
    });
  }

  async function changeRole(member: Membership, newRole: Role) {
    // RLS zakázaná změna vrátí 0 řádků bez chyby — kontrolovat výsledek
    const { data, error } = await supabase
      .from("workspace_members")
      .update({ role: newRole })
      .eq("workspace_id", wsId)
      .eq("user_id", member.user_id)
      .select("user_id");
    if (error || !data?.length) setMessage("Roli může měnit jen super-admin.");
    load();
  }

  function startEdit(t: {
    id: string;
    full_name?: string | null;
    avatar_initials?: string | null;
    avatar_color?: string | null;
    tag_name?: string | null;
  }) {
    setEditId(t.id);
    setEName(t.full_name ?? "");
    setEInitials(t.avatar_initials ?? "");
    setEColor(t.avatar_color ?? "");
    setETag(t.tag_name ?? "");
  }

  async function saveEdit(userId: string) {
    // tag: bez zavináče, malými písmeny; povolena písmena/číslice/._
    const tag = eTag.trim().replace(/^@/, "").toLowerCase();
    if (tag && !/^[a-z0-9_.]{2,30}$/.test(tag)) {
      toast("Tag smí mít 2–30 znaků: písmena, číslice, tečka, podtržítko.", "error");
      return;
    }
    const { error } = await supabase
      .from("profiles")
      .update({
        full_name: eName.trim(),
        avatar_initials: eInitials.trim().toUpperCase().slice(0, 3),
        avatar_color: eColor,
        tag_name: tag,
      })
      .eq("id", userId);
    if (error) {
      toast(
        error.code === "23505"
          ? `Tag @${tag} už používá někdo jiný.`
          : "Uložení profilu se nezdařilo.",
        "error"
      );
      return;
    }
    setEditId(null);
    toast("Profil uložen.");
    load();
    if (allUsers) loadAll();
  }

  async function remove(member: Membership) {
    const name = member.profiles?.full_name || member.profiles?.email;
    const ok = await confirmDialog({
      title: "Odebrat člena?",
      message: `${name} přijde o přístup k tomuto workspace.`,
      confirmLabel: "Odebrat",
    });
    if (!ok) return;
    // RLS zakázané mazání vrátí 204 bez řádků, ne chybu — kontrolovat výsledek
    const { data, error } = await supabase
      .from("workspace_members")
      .delete()
      .eq("workspace_id", wsId)
      .eq("user_id", member.user_id)
      .select("user_id");
    if (error || !data?.length)
      setMessage("Odebrání se nezdařilo (admina odebírá jen super-admin).");
    load();
  }

  if (loading) return <ListSkeleton />;

  return (
    <div className="space-y-4">
      <form onSubmit={invite} className="space-y-3 panel p-3">
        <div className="inline-flex rounded-lg bg-black/5 p-0.5 text-sm">
          {(
            [
              ["portal", "Z portálu"],
              ["email", "E-mailem"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setMode(key);
                setMessage(null);
              }}
              className={`rounded-md px-3 py-1 transition-colors ${
                mode === key
                  ? "bg-surface font-medium text-ink shadow-sm"
                  : "text-ink-soft hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {mode === "portal" ? (
            <div className="min-w-48 flex-1">
              <Picker
                options={portalUsers.map((u) => ({
                  id: u.id as string | null,
                  label: u.full_name || u.email,
                }))}
                value={pickedUserId}
                onChange={setPickedUserId}
                placeholder={
                  portalUsers.length ? "Vyber uživatele" : "Žádní volní uživatelé"
                }
                iconPath={USER_ICON}
                ariaLabel="Uživatel z portálu"
                align="left"
                disabled={portalUsers.length === 0}
              />
            </div>
          ) : (
            <input
              type="email"
              required
              placeholder="email@firma.cz"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="min-w-48 flex-1 input"
            />
          )}
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            aria-label="Role"
            className="input px-2"
          >
            <option value="member">Member</option>
            {isSuperAdmin && <option value="admin">Admin</option>}
          </select>
          <button type="submit" disabled={pending} className="btn-primary">
            {pending ? "Přidávám…" : mode === "portal" ? "Přidat" : "Pozvat"}
          </button>
        </div>
        {message && <p className="text-sm text-ink-soft">{message}</p>}
      </form>

      {isSuperAdmin && (
        <div className="inline-flex rounded-lg bg-black/5 p-0.5 text-sm">
          {(
            [
              ["workspace", "Tato firma"],
              ["all", "Všichni uživatelé"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`rounded-md px-3 py-1 transition-colors ${
                tab === key
                  ? "bg-surface font-medium text-ink shadow-sm"
                  : "text-ink-soft hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {tab === "all" && isSuperAdmin ? (
        allLoading ? (
          <p className="p-4 text-ink-soft/70">Načítám…</p>
        ) : allError ? (
          <p className="p-4 text-sm text-danger">{allError}</p>
        ) : !allUsers?.length ? (
          <p className="p-4 text-ink-soft/70">Žádní uživatelé.</p>
        ) : (
          <div className="divide-y divide-line/70 panel">
            {allUsers.map((u) => (
              <div key={u.id}>
                <div className="flex items-center gap-3 px-3 py-2">
                  <Avatar profile={u} colorKey={u.id} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">
                      {u.full_name || u.email}
                      {u.tag_name && (
                        <span className="ml-1.5 text-xs text-accent">
                          @{u.tag_name}
                        </span>
                      )}
                      {u.id === currentUserId && (
                        <span className="text-ink-soft/70"> (ty)</span>
                      )}
                      {u.is_super_admin && (
                        <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                          super-admin
                        </span>
                      )}
                      {u.status === "pending" && (
                        <span
                          className="ml-1.5 rounded bg-black/5 px-1.5 py-0.5 text-xs text-ink-soft"
                          title="Pozván, ale ještě si nenastavil heslo"
                        >
                          čeká na aktivaci
                        </span>
                      )}
                    </p>
                    <p className="truncate text-xs text-ink-soft/70">{u.email}</p>
                    {u.memberships.length ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {u.memberships.map((m) => (
                          <span
                            key={m.workspaceId}
                            className="inline-flex items-center gap-1 rounded bg-black/5 px-1.5 py-0.5 text-xs text-ink-soft"
                          >
                            {m.workspaceName}
                            <span
                              className={
                                m.role === "admin"
                                  ? "text-amber-700"
                                  : "text-ink-soft/60"
                              }
                            >
                              · {m.role}
                            </span>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-1 text-xs text-ink-soft/50">V žádné firmě</p>
                    )}
                  </div>
                  <button
                    onClick={() =>
                      editId === u.id ? setEditId(null) : startEdit(u)
                    }
                    aria-expanded={editId === u.id}
                    className={`rounded-md px-2 py-1 text-xs hover:bg-black/5 ${
                      editId === u.id
                        ? "bg-accent-soft text-accent"
                        : "text-ink-soft"
                    }`}
                  >
                    Upravit
                  </button>
                </div>

                {editId === u.id && (
                  <ProfileEditForm
                    email={u.email}
                    colorKey={u.id}
                    eName={eName}
                    setEName={setEName}
                    eInitials={eInitials}
                    setEInitials={setEInitials}
                    eColor={eColor}
                    setEColor={setEColor}
                    eTag={eTag}
                    setETag={setETag}
                    onCancel={() => setEditId(null)}
                    onSave={() => saveEdit(u.id)}
                  />
                )}
              </div>
            ))}
          </div>
        )
      ) : (
      <div className="divide-y divide-line/70 panel">
        {members.map((member) => (
          <div key={member.user_id}>
            <div className="flex items-center gap-3 px-3 py-2">
              <Avatar
                profile={member.profiles}
                colorKey={member.user_id}
                size="md"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">
                  {member.profiles?.full_name || member.profiles?.email}
                  {member.profiles?.tag_name && (
                    <span className="ml-1.5 text-xs text-accent">
                      @{member.profiles.tag_name}
                    </span>
                  )}
                  {member.user_id === currentUserId && (
                    <span className="text-ink-soft/70"> (ty)</span>
                  )}
                </p>
                <p className="truncate text-xs text-ink-soft/70">{member.profiles?.email}</p>
              </div>
              <button
                onClick={() =>
                  editId === member.user_id
                    ? setEditId(null)
                    : startEdit({ id: member.user_id, ...member.profiles })
                }
                aria-expanded={editId === member.user_id}
                className={`rounded-md px-2 py-1 text-xs hover:bg-black/5 ${
                  editId === member.user_id
                    ? "bg-accent-soft text-accent"
                    : "text-ink-soft"
                }`}
              >
                Upravit
              </button>
              {isSuperAdmin ? (
                <select
                  value={member.role}
                  onChange={(e) => changeRole(member, e.target.value as Role)}
                  className="input px-2 py-1 text-xs"
                >
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                </select>
              ) : (
                <span
                  className={`rounded px-1.5 py-0.5 text-xs ${
                    member.role === "admin"
                      ? "bg-amber-100 text-amber-800"
                      : "bg-black/5 text-ink-soft"
                  }`}
                >
                  {member.role}
                </span>
              )}
              <button
                onClick={() => remove(member)}
                className="rounded-md px-2 py-1 text-xs text-danger hover:bg-danger/10"
              >
                Odebrat
              </button>
            </div>

            {editId === member.user_id && (
              <>
                <ProfileEditForm
                  email={member.profiles?.email}
                  colorKey={member.user_id}
                  eName={eName}
                  setEName={setEName}
                  eInitials={eInitials}
                  setEInitials={setEInitials}
                  eColor={eColor}
                  setEColor={setEColor}
                  eTag={eTag}
                  setETag={setETag}
                  onCancel={() => setEditId(null)}
                  onSave={() => saveEdit(member.user_id)}
                />
                <NotifyEmailEditor
                  wsId={wsId}
                  userId={member.user_id}
                  initial={member.notify_email ?? ""}
                  accountEmail={member.profiles?.email ?? ""}
                  onSaved={load}
                />
                <MemberFlagToggle
                  wsId={wsId}
                  userId={member.user_id}
                  flag="notify_enabled"
                  title="E-mailové notifikace"
                  hint="Vypnuté = z této firmy nechodí žádné e-maily (přiřazení, komentáře, zmínky, denní přehled). Zvoneček v aplikaci zůstává."
                  initial={member.notify_enabled ?? true}
                  onSaved={load}
                />
                <GrantsEditor
                  wsId={wsId}
                  userId={member.user_id}
                  table="assign_grants"
                  title="Smí zadávat úkoly pro"
                  hint="Sebe vždy; ostatní jen s tímto oprávněním."
                  adminNote="Admin může zadávat úkoly komukoli."
                  isAdminMember={member.role === "admin"}
                  members={members}
                />
                {member.role === "admin" ? (
                  <p className="border-t border-line/50 bg-black/[.015] px-3 py-2 text-xs text-ink-soft/70">
                    Admin může delegovat, skrývat úkoly i vidět výkazy všech vždy.
                  </p>
                ) : (
                  <>
                    <MemberFlagToggle
                      wsId={wsId}
                      userId={member.user_id}
                      flag="can_delegate"
                      title="Může delegovat"
                      hint={'Odemkne follow-upy a stránku „Čekám na".'}
                      initial={member.can_delegate ?? false}
                      onSaved={load}
                    />
                    <MemberFlagToggle
                      wsId={wsId}
                      userId={member.user_id}
                      flag="can_hide"
                      title="Skryté úkoly"
                      hint="Odemkne zakládání úkolů, které vidí jen jejich autor."
                      initial={member.can_hide ?? false}
                      onSaved={load}
                    />
                    <MemberFlagToggle
                      wsId={wsId}
                      userId={member.user_id}
                      flag="time_only"
                      title="Jen měření času"
                      hint="Osekané rozhraní: člen vidí jen timer a Report, žádné úkoly. Úkoly na něj jde dál věšet — jen je nevidí."
                      initial={member.time_only ?? false}
                      onSaved={load}
                    />
                    <MemberFlagToggle
                      wsId={wsId}
                      userId={member.user_id}
                      flag="percent_report"
                      title="Výkaz v %"
                      hint="Místo timeru vyplňuje denní výkaz procenty na projekty (8h den) — rozpadne se do záznamů času. Zahrnuje osekané rozhraní Jen měření času; timer a ruční zápis se schovají."
                      initial={member.percent_report ?? false}
                      onSaved={load}
                    />
                    <MemberFlagToggle
                      wsId={wsId}
                      userId={member.user_id}
                      flag="can_hr"
                      title="HR"
                      hint="Odemkne výkazy přidělených lidí v Přehledech včetně exportu do PDF (bez sazeb — ty vidí jen admin)."
                      initial={member.can_hr ?? false}
                      onSaved={load}
                    />
                    {member.can_hr && (
                      <GrantsEditor
                        wsId={wsId}
                        userId={member.user_id}
                        table="hr_grants"
                        title="HR: vidí výkazy pro"
                        hint="Výkazy vybraných lidí uvidí v Přehledech a vyexportuje do PDF."
                        adminNote="Admin vidí výkazy všech."
                        isAdminMember={false}
                        members={members}
                      />
                    )}
                  </>
                )}
                {/* Poznámky — osobní scratchpad; dostupné i adminům (nemají
                    override, musí si to zapnout sami) */}
                <MemberFlagToggle
                  wsId={wsId}
                  userId={member.user_id}
                  flag="can_notes"
                  title="Poznámky"
                  hint="Odemkne osobní poznámkový blok v sekci Master (soukromý, jen pro daného člověka)."
                  initial={member.can_notes ?? false}
                  onSaved={load}
                />
              </>
            )}
          </div>
        ))}
      </div>
      )}

      <div className="border-t border-line/70 pt-4">
        <ContactsSection wsId={wsId} />
      </div>
    </div>
  );
}

/** Per-firma notifikační e-mail člena. Vlastní stav, ukládá jen admin přes
    setMemberNotifyEmail. Prázdný = notifikace jdou na účetní e-mail. */
function NotifyEmailEditor({
  wsId,
  userId,
  initial,
  accountEmail,
  onSaved,
}: {
  wsId: string;
  userId: string;
  initial: string;
  accountEmail: string;
  onSaved: () => void;
}) {
  const [val, setVal] = useState(initial);
  const [saving, setSaving] = useState(false);
  const dirty = val.trim() !== initial.trim();

  async function save() {
    setSaving(true);
    const res = await safeAction(() => setMemberNotifyEmail(wsId, userId, val.trim()));
    setSaving(false);
    if (res.error) {
      toast(res.error, "error");
      return;
    }
    toast(val.trim() ? "Notifikační e-mail uložen." : "Notifikační e-mail zrušen.");
    onSaved();
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line/50 bg-black/[.015] px-3 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">Notifikační e-mail</p>
        <p className="text-xs text-ink-soft/70">
          Jen tato firma. Prázdné = chodí na {accountEmail || "účetní e-mail"}.
        </p>
      </div>
      <input
        type="email"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder={accountEmail || "email@firma.cz"}
        aria-label="Notifikační e-mail pro tuto firmu"
        className="input min-w-48 flex-1 px-2 py-1 text-sm"
      />
      <button
        onClick={save}
        disabled={saving || !dirty}
        className="btn-primary px-3 py-1 text-xs disabled:opacity-60"
      >
        {saving ? "Ukládám…" : "Uložit"}
      </button>
    </div>
  );
}

/** Per-firma flag člena: odemknutí funkce navíc (delegace / skryté úkoly —
    admini je mají vždy, u nich se nezobrazují) nebo e-mailové notifikace. */
function MemberFlagToggle({
  wsId,
  userId,
  flag,
  title,
  hint,
  initial,
  onSaved,
}: {
  wsId: string;
  userId: string;
  flag:
    | "can_delegate"
    | "can_hide"
    | "notify_enabled"
    | "can_hr"
    | "can_notes"
    | "time_only"
    | "percent_report";
  title: string;
  hint: string;
  initial: boolean;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);

  async function toggle(next: boolean) {
    setSaving(true);
    const res = await safeAction(() => setMemberFlag(wsId, userId, flag, next));
    setSaving(false);
    if (res.error) {
      toast(res.error, "error");
      return;
    }
    toast(next ? `${title}: zapnuto.` : `${title}: vypnuto.`);
    onSaved();
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line/50 bg-black/[.015] px-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-ink-soft/70">{hint}</p>
      </div>
      <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={initial}
          disabled={saving}
          onChange={(e) => toggle(e.target.checked)}
          className="h-4 w-4"
        />
        {initial ? "zapnuto" : "vypnuto"}
      </label>
    </div>
  );
}

/** Obecný editor grantů user → target (assign_grants / hr_grants). Admin má
    obě práva implicitně, proto se u něj místo editoru ukazuje poznámka. */
function GrantsEditor({
  wsId,
  userId,
  table,
  title,
  hint,
  adminNote,
  isAdminMember,
  members,
}: {
  wsId: string;
  userId: string;
  table: "assign_grants" | "hr_grants";
  title: string;
  hint: string;
  adminNote: string;
  isAdminMember: boolean;
  members: Membership[];
}) {
  const supabase = createClient();
  const [targets, setTargets] = useState<Set<string> | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from(table)
      .select("target_id")
      .eq("workspace_id", wsId)
      .eq("user_id", userId);
    setTargets(new Set((data ?? []).map((r) => r.target_id as string)));
  }, [supabase, wsId, userId, table]);

  useEffect(() => {
    if (!isAdminMember) load();
  }, [load, isAdminMember]);

  async function toggle(targetId: string) {
    if (!targets) return;
    const on = targets.has(targetId);
    const next = new Set(targets);
    if (on) next.delete(targetId);
    else next.add(targetId);
    setTargets(next);
    const { error } = on
      ? await supabase
          .from(table)
          .delete()
          .eq("workspace_id", wsId)
          .eq("user_id", userId)
          .eq("target_id", targetId)
      : await supabase
          .from(table)
          .insert({ workspace_id: wsId, user_id: userId, target_id: targetId });
    if (error) {
      toast("Změna práva se nezdařila.", "error");
      load();
    }
  }

  if (isAdminMember) {
    return (
      <p className="border-t border-line/50 bg-black/[.015] px-3 py-2 text-xs text-ink-soft/70">
        {adminNote}
      </p>
    );
  }

  const others = members.filter((m) => m.user_id !== userId);

  return (
    <div className="border-t border-line/50 bg-black/[.015] px-3 py-3">
      <p className="text-sm font-medium">{title}</p>
      <p className="pb-1.5 text-xs text-ink-soft/70">{hint}</p>
      {targets === null ? (
        <p className="text-sm text-ink-soft/70">Načítám…</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {others.map((m) => {
            const on = targets.has(m.user_id);
            const name = m.profiles?.full_name || m.profiles?.email || "?";
            return (
              <button
                key={m.user_id}
                onClick={() => toggle(m.user_id)}
                aria-pressed={on}
                className={`inline-flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2 text-xs transition-colors ${
                  on
                    ? "border-transparent bg-accent text-white"
                    : "border-line text-ink-soft hover:border-ink-soft/40"
                }`}
              >
                <Avatar profile={m.profiles} colorKey={m.user_id} size="xs" />
                {name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Inline editace profilu (jméno, iniciály, barva avataru, @tag). Stav drží
    rodič — používá ho seznam členů firmy i seznam všech uživatelů. */
function ProfileEditForm({
  email,
  colorKey,
  eName,
  setEName,
  eInitials,
  setEInitials,
  eColor,
  setEColor,
  eTag,
  setETag,
  onCancel,
  onSave,
}: {
  email?: string | null;
  colorKey: string;
  eName: string;
  setEName: (v: string) => void;
  eInitials: string;
  setEInitials: (v: string) => void;
  eColor: string;
  setEColor: (v: string) => void;
  eTag: string;
  setETag: (v: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="space-y-2 border-t border-line/50 bg-black/[.015] px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Avatar
          profile={{
            full_name: eName,
            email,
            avatar_initials: eInitials,
            avatar_color: eColor,
          }}
          colorKey={colorKey}
          size="lg"
        />
        <input
          type="text"
          value={eName}
          onChange={(e) => setEName(e.target.value)}
          placeholder="Jméno a příjmení"
          aria-label="Jméno a příjmení"
          className="input min-w-44 flex-1"
        />
        <input
          type="text"
          value={eInitials}
          onChange={(e) => setEInitials(e.target.value)}
          maxLength={3}
          placeholder={avatarInitials({ full_name: eName, email })}
          aria-label="Iniciály (max 3 znaky)"
          title="Iniciály — prázdné se odvodí ze jména"
          className="input w-16 text-center uppercase"
        />
        <span className="inline-flex items-center gap-0.5">
          <span className="text-sm text-ink-soft/70">@</span>
          <input
            type="text"
            value={eTag}
            onChange={(e) => setETag(e.target.value)}
            maxLength={30}
            placeholder="tag"
            aria-label="Tag name (bez zavináče)"
            title="Unikátní tag, např. kostikova"
            className="input w-32 lowercase"
          />
        </span>
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
          value={eColor || "#0e7569"}
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
            Automatická
          </button>
        )}
        <span className="flex-1" />
        <button onClick={onCancel} className="btn-ghost px-2 py-1 text-xs">
          Zrušit
        </button>
        <button onClick={onSave} className="btn-primary px-3 py-1 text-xs">
          Uložit
        </button>
      </div>
    </div>
  );
}
