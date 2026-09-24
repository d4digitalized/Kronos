import { cache } from "react";
import { isAuthRetryableFetchError, type SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { staticJwks } from "@/lib/jwks";
import type { Membership, Profile, Workspace, WorkspaceOption } from "@/lib/types";

// Přihlášený uživatel a jeho práva ve firmě — JEDNOU na požadavek.
//
// Dřív každá vrstva (proxy → layout → stránka → helper v auth.ts) volala
// znovu supabase.auth.getUser() (síťová cesta na Supabase Auth) a znovu
// tahala profil + členství. Sériově to dělalo 5–7 round-tripů na render.
// Teď: podpis JWT se ověří lokálně (getClaims, asymetrický klíč projektu)
// a profil/firma/členství/granty se natáhnou jedním paralelním dotazem,
// který přes React cache() sdílí layout i stránka téhož požadavku.

export type SessionUser = {
  id: string;
  email: string;
  /** účet propojený s Googlem (claim app_metadata.providers) */
  googleLinked: boolean;
};

/** Ověří session z cookies bez cesty na Supabase Auth (u HS256 tokenů
    knihovna sama spadne zpět na getUser). */
export async function readSessionUser(
  supabase: SupabaseClient
): Promise<SessionUser | null> {
  const jwks = staticJwks();
  const { data, error } = await supabase.auth.getClaims(
    undefined,
    jwks ? { jwks } : undefined
  );
  // výpadek spojení se Supabase ≠ odhlášení: vyhodit chybu (error.tsx nabídne
  // „Zkusit znovu") místo přesměrování na přihlášení
  if (error && isAuthRetryableFetchError(error))
    throw new Error("Přihlášení se teď nepodařilo ověřit (spojení se Supabase).");
  const claims = data?.claims;
  if (!claims?.sub) return null;
  const meta = claims.app_metadata as { providers?: string[] } | undefined;
  return {
    id: claims.sub,
    email: (claims.email as string | undefined) ?? "",
    googleLinked: (meta?.providers ?? []).includes("google"),
  };
}

/** Přihlášený uživatel — sdílený v rámci požadavku. */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createClient();
  return readSessionUser(supabase);
});

export type WsContext = {
  user: SessionUser;
  profile: Profile | null;
  /** firma z URL; null = neexistuje / bez přístupu */
  ws: Workspace | null;
  /** moje členství v této firmě (super-admin ho mít nemusí) */
  membership: Membership | null;
  isSuperAdmin: boolean;
  /** super-admin nebo role admin (= RPC is_ws_admin) */
  isAdmin: boolean;
  /** super-admin nebo člen (= RPC is_ws_member) */
  isMember: boolean;
  canDelegate: boolean;
  canHide: boolean;
  /** smí zadávat i jiným: admin / aspoň jeden grant */
  canTaskforce: boolean;
  canNotes: boolean;
  /** výkaz v % místo timeru (adminům se flag ignoruje) */
  percentReport: boolean;
  /** „jen měření času" — osekané rozhraní (adminům se flag ignoruje) */
  timeOnly: boolean;
  /** všechny mé firmy vč. práv v nich (přepínač v „Nový úkol") */
  wsOptions: WorkspaceOption[];
  workspaces: Workspace[];
};

/** Kontext firmy pro přihlášeného uživatele — jeden paralelní dotaz na
    požadavek, sdílený layoutem, stránkou i auth helpery. null = nepřihlášen. */
export const getWsContext = cache(
  async (wsId: string): Promise<WsContext | null> => {
    const user = await getSessionUser();
    if (!user) return null;
    const supabase = await createClient();

    const [profileRes, wsRes, membershipsRes, grantsRes] = await Promise.all([
      supabase.from("profiles").select("*").eq("id", user.id).single(),
      supabase.from("workspaces").select("id, name").eq("id", wsId).maybeSingle(),
      supabase
        .from("workspace_members")
        .select("*, workspaces(id, name)")
        .eq("user_id", user.id),
      supabase
        .from("assign_grants")
        .select("target_id", { count: "exact", head: true })
        .eq("workspace_id", wsId)
        .eq("user_id", user.id),
    ]);
    // Chyba dotazu ≠ „firma neexistuje" / „nejsi člen": dřív z ní byla 404
    // nebo přesměrování pryč. Teď skončí v error.tsx se „Zkusit znovu".
    // (PGRST116 = profil bez řádku — to není chyba spojení.)
    const failed = [
      profileRes.error?.code === "PGRST116" ? null : profileRes.error,
      wsRes.error,
      membershipsRes.error,
      grantsRes.error,
    ].find(Boolean);
    if (failed) throw new Error(`Kontext firmy se nepodařilo načíst: ${failed.message}`);
    const profile = profileRes.data;
    const ws = wsRes.data;
    const grantCount = grantsRes.count;

    const all = (membershipsRes.data ?? []) as unknown as Membership[];
    const membership = all.find((m) => m.workspace_id === wsId) ?? null;
    const isSuperAdmin = profile?.is_super_admin ?? false;
    const isAdmin = isSuperAdmin || membership?.role === "admin";
    const isMember = isSuperAdmin || !!membership;
    // funkce navíc: adminům vždy, členům dle flagů odemčených adminem
    const canDelegate = isAdmin || !!membership?.can_delegate;
    const canHide = isAdmin || !!membership?.can_hide;
    const canTaskforce = isAdmin || (grantCount ?? 0) > 0;
    const canNotes = !!membership?.can_notes;
    const percentReport = !isAdmin && !!membership?.percent_report;
    const timeOnly = (!isAdmin && !!membership?.time_only) || percentReport;

    // ke každé mé firmě i práva v ní — přepínač v „Nový úkol" je potřebuje,
    // canDelegate/canHide se firmu od firmy liší
    const wsOptions: WorkspaceOption[] = all
      .filter((m) => m.workspaces)
      .map((m) => {
        const w = m.workspaces as Workspace;
        const wsAdmin = isSuperAdmin || m.role === "admin";
        return {
          id: w.id,
          name: w.name,
          canDelegate: wsAdmin || !!m.can_delegate,
          canHide: wsAdmin || !!m.can_hide,
        };
      });
    // super-admin může být na firmě, kde členem není
    if (ws && !wsOptions.some((w) => w.id === ws.id))
      wsOptions.unshift({ id: ws.id, name: ws.name, canDelegate, canHide });

    return {
      user,
      profile: (profile as Profile | null) ?? null,
      ws: (ws as Workspace | null) ?? null,
      membership,
      isSuperAdmin,
      isAdmin,
      isMember,
      canDelegate,
      canHide,
      canTaskforce,
      canNotes,
      percentReport,
      timeOnly,
      wsOptions,
      workspaces: wsOptions.map(({ id, name }) => ({ id, name })),
    };
  }
);
