import { redirect } from "next/navigation";
import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/safeNext";

// Návrat z OAuth poskytovatele (Google): výměna ?code za session (PKCE —
// code_verifier je v cookie od browser klienta) a přesměrování do aplikace.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  // jen vlastní cesta, ať nejde o open redirect
  const next = safeNextPath(searchParams.get("next"));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) redirect(next);
  }

  redirect("/login?error=oauth");
}
