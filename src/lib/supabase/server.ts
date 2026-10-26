import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { cache } from "react";
import { resilientFetch } from "@/lib/supabase/fetch";

const authFetch = resilientFetch(5_000);

// Memoizováno na požadavek (React cache): layout i stránka sdílí jednoho
// klienta, a hlavně sdílí výsledek getClaims()/getSession() uvnitř něj.
export const createClient = cache(async () => {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { fetch: authFetch },
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // volané ze server componenty — session refresh řeší proxy
          }
        },
      },
    }
  );
});
