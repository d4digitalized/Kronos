"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Role } from "@/lib/types";

const INVITE_ERROR =
  "Pozvánkový e-mail se nepodařilo odeslat. Bez vlastního SMTP posílá Supabase max. ~2 e-maily za hodinu — zkus to později, nebo nastav SMTP (Resend) podle README.";

/** Najde účet podle e-mailu; když neexistuje, pošle pozvánku a účet založí. */
async function resolveOrInviteUser(
  normalized: string
): Promise<{ userId?: string; invited: boolean; error?: string }> {
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("profiles")
    .select("id")
    .eq("email", normalized)
    .maybeSingle();
  if (existing?.id) return { userId: existing.id as string, invited: false };

  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const { data, error } = await admin.auth.admin.inviteUserByEmail(normalized, {
    redirectTo: `${site}/auth/confirm`,
  });
  if (error || !data.user) return { invited: true, error: INVITE_ERROR };
  return { userId: data.user.id, invited: true };
}

/** Uživatelé portálu, kteří zatím nejsou členy daného workspace. Jen pro
    super-admina — seznam nese jména a e-maily lidí ze všech firem; admin
    firmy přidává existující účet podle přesného e-mailu (inviteMember). */
export async function listAddablePortalUsers(wsId: string): Promise<{
  users?: { id: string; email: string; full_name: string }[];
  error?: string;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Nejsi přihlášený." };

  const { data: me } = await supabase
    .from("profiles")
    .select("is_super_admin")
    .eq("id", user.id)
    .single();
  if (!me?.is_super_admin) return { error: "Seznam uživatelů portálu vidí jen super-admin." };

  const admin = createAdminClient();
  const [{ data: profiles }, { data: members }] = await Promise.all([
    admin.from("profiles").select("id, email, full_name").order("full_name"),
    admin.from("workspace_members").select("user_id").eq("workspace_id", wsId),
  ]);

  const memberIds = new Set((members ?? []).map((m) => m.user_id));
  const users = (profiles ?? [])
    .filter((p) => !memberIds.has(p.id))
    .map((p) => ({ id: p.id, email: p.email, full_name: p.full_name }));
  return { users };
}

export type AppUser = {
  id: string;
  email: string;
  full_name: string;
  avatar_initials: string | null;
  avatar_color: string | null;
  tag_name: string | null;
  is_super_admin: boolean;
  /** active = nastavené heslo/potvrzený účet; pending = pozván, ještě neaktivoval */
  status: "active" | "pending";
  memberships: { workspaceId: string; workspaceName: string; role: Role }[];
};

/** Všichni uživatelé aplikace napříč firmami — s firmami, rolemi a stavem účtu.
    Citlivé (cross-tenant), proto jen pro super-admina. */
export async function listAllUsers(): Promise<{
  users?: AppUser[];
  error?: string;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Nejsi přihlášený." };

  const { data: me } = await supabase
    .from("profiles")
    .select("is_super_admin")
    .eq("id", user.id)
    .single();
  if (!me?.is_super_admin)
    return { error: "Seznam všech uživatelů vidí jen super-admin." };

  const admin = createAdminClient();
  const [{ data: profiles }, { data: members }, { data: workspaces }, authList] =
    await Promise.all([
      admin
        .from("profiles")
        .select(
          "id, email, full_name, is_super_admin, avatar_initials, avatar_color, tag_name"
        )
        .order("full_name"),
      admin.from("workspace_members").select("user_id, workspace_id, role"),
      admin.from("workspaces").select("id, name"),
      admin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
    ]);

  const wsName = new Map((workspaces ?? []).map((w) => [w.id, w.name as string]));
  const byUser = new Map<string, AppUser["memberships"]>();
  for (const m of members ?? []) {
    const list = byUser.get(m.user_id) ?? [];
    list.push({
      workspaceId: m.workspace_id,
      workspaceName: wsName.get(m.workspace_id) ?? "?",
      role: m.role as Role,
    });
    byUser.set(m.user_id, list);
  }

  // potvrzený účet = přihlásil se nebo potvrdil e-mail; jinak jen pozvaný
  const confirmed = new Set(
    (authList.data?.users ?? [])
      .filter((u) => u.email_confirmed_at || u.last_sign_in_at)
      .map((u) => u.id)
  );

  const users: AppUser[] = (profiles ?? []).map((p) => ({
    id: p.id,
    email: p.email,
    full_name: p.full_name,
    avatar_initials: p.avatar_initials ?? null,
    avatar_color: p.avatar_color ?? null,
    tag_name: p.tag_name ?? null,
    is_super_admin: p.is_super_admin,
    status: confirmed.has(p.id) ? "active" : "pending",
    memberships: (byUser.get(p.id) ?? []).sort((a, b) =>
      a.workspaceName.localeCompare(b.workspaceName)
    ),
  }));

  return { users };
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Nastaví (nebo vymaže) notifikační e-mail člena pro danou firmu.
    Prázdný string = notifikace půjdou na účetní e-mail. Jen admin workspace. */
export async function setMemberNotifyEmail(
  wsId: string,
  userId: string,
  email: string
): Promise<{ ok?: true; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Nejsi přihlášený." };

  const { data: isAdmin } = await supabase.rpc("is_ws_admin", { ws: wsId });
  if (!isAdmin) return { error: "Notifikační e-mail nastavuje jen admin." };

  const normalized = email.trim().toLowerCase();
  if (normalized && !EMAIL_RE.test(normalized))
    return { error: "Neplatný e-mail." };

  // přes service-role: RLS update na workspace_members je jen pro super-admina,
  // oprávnění tu hlídá kontrola is_ws_admin výše
  const admin = createAdminClient();
  const { error } = await admin
    .from("workspace_members")
    .update({ notify_email: normalized })
    .eq("workspace_id", wsId)
    .eq("user_id", userId);
  if (error) return { error: "Uložení se nezdařilo." };
  return { ok: true };
}

// jediné sloupce, které smí setMemberFlag měnit (viz níž)
const MEMBER_FLAGS = new Set<string>([
  "can_delegate",
  "can_hide",
  "notify_enabled",
  "can_hr",
  "can_notes",
  "time_only",
  "percent_report",
]);

/** Přepne členovi per-firma flag: delegaci úkolů („Čekám na", Delegované),
    skryté úkoly (adminům je aplikace dává vždy bez ohledu na flag),
    e-mailové notifikace (notify_enabled), nebo HR (výkazy přidělených lidí).
    Jen admin workspace. */
export async function setMemberFlag(
  wsId: string,
  userId: string,
  flag:
    | "can_delegate"
    | "can_hide"
    | "notify_enabled"
    | "can_hr"
    | "can_notes"
    | "time_only"
    | "percent_report",
  value: boolean
): Promise<{ ok?: true; error?: string }> {
  // server action je veřejný endpoint a typy TS za běhu neplatí: bez téhle
  // kontroly by admin firmy service-role klíčem přepsal i role nebo
  // workspace_id (= přesun svého členství do cizí firmy)
  if (!MEMBER_FLAGS.has(flag) || typeof value !== "boolean")
    return { error: "Neplatný požadavek." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Nejsi přihlášený." };

  const { data: isAdmin } = await supabase.rpc("is_ws_admin", { ws: wsId });
  if (!isAdmin) return { error: "Tuhle funkci odemyká jen admin." };

  // přes service-role: RLS update na workspace_members je jen pro super-admina,
  // oprávnění tu hlídá kontrola is_ws_admin výše
  const admin = createAdminClient();
  const { error } = await admin
    .from("workspace_members")
    .update({ [flag]: value })
    .eq("workspace_id", wsId)
    .eq("user_id", userId);
  if (error) return { error: "Uložení se nezdařilo." };

  // vypnutí HR uklidí i granty — právo zmizí celé, ne jen naoko
  if (flag === "can_hr" && !value) {
    await admin
      .from("hr_grants")
      .delete()
      .eq("workspace_id", wsId)
      .eq("user_id", userId);
  }
  return { ok: true };
}

export async function inviteMember(
  wsId: string,
  email: string,
  role: Role
): Promise<{ ok?: true; invited?: boolean; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Nejsi přihlášený." };

  const { data: isAdmin } = await supabase.rpc("is_ws_admin", { ws: wsId });
  if (!isAdmin) return { error: "Na pozvánky nemáš oprávnění." };

  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) return { error: "Neplatný e-mail." };

  const resolved = await resolveOrInviteUser(normalized);
  if (resolved.error || !resolved.userId) return { error: resolved.error };

  // membership přes user-scoped klienta — RLS vynutí, že admina smí přidat jen super-admin
  const { error: insertError } = await supabase
    .from("workspace_members")
    .insert({ workspace_id: wsId, user_id: resolved.userId, role });

  if (insertError) {
    if (insertError.code === "23505") return { error: "Už je členem workspace." };
    return { error: "Přidání se nezdařilo. Admina může jmenovat jen super-admin." };
  }
  return { ok: true, invited: resolved.invited };
}

/** Super-admin: přidá (případně nejdřív pozve) uživatele do více workspaces najednou. */
export async function inviteToWorkspaces(
  email: string,
  role: Role,
  wsIds: string[]
): Promise<{
  ok?: true;
  invited?: boolean;
  added?: number;
  alreadyMember?: number;
  failed?: number;
  error?: string;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Nejsi přihlášený." };

  const { data: profile } = await supabase
    .from("profiles")
    .select("is_super_admin")
    .eq("id", user.id)
    .single();
  if (!profile?.is_super_admin)
    return { error: "Hromadné přidávání může jen super-admin." };

  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) return { error: "Neplatný e-mail." };
  if (wsIds.length === 0) return { error: "Vyber aspoň jednu firmu." };

  const resolved = await resolveOrInviteUser(normalized);
  if (resolved.error || !resolved.userId) return { error: resolved.error };

  let added = 0;
  let alreadyMember = 0;
  let failed = 0;
  for (const wsId of wsIds) {
    const { error: insertError } = await supabase
      .from("workspace_members")
      .insert({ workspace_id: wsId, user_id: resolved.userId, role });
    if (!insertError) added++;
    else if (insertError.code === "23505") alreadyMember++;
    else failed++;
  }

  return { ok: true, invited: resolved.invited, added, alreadyMember, failed };
}
