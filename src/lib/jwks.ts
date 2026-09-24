import type { SupabaseClient } from "@supabase/supabase-js";

/** Volitelně statické JWKS (env SUPABASE_JWKS = JSON z
    /auth/v1/.well-known/jwks.json) — ušetří jeden fetch na studeném startu.
    Když klíč nesedí (rotace), knihovna si JWKS stejně stáhne sama.
    Sdílí ho proxy i server komponenty. */
type ClaimsOptions = NonNullable<Parameters<SupabaseClient["auth"]["getClaims"]>[1]>;
type Jwks = NonNullable<ClaimsOptions["jwks"]>;

export function staticJwks(): Jwks | undefined {
  const raw = process.env.SUPABASE_JWKS;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<Jwks>;
    return Array.isArray(parsed?.keys) ? (parsed as Jwks) : undefined;
  } catch {
    return undefined;
  }
}
