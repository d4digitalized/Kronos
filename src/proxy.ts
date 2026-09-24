import { createServerClient } from "@supabase/ssr";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { staticJwks } from "@/lib/jwks";

// /api/cron chrání CRON_SECRET (Bearer), /api/inbound svix podpis webooku,
// /api/mcp vlastní bearer API token (withMcpAuth), /api/oauth + /oauth + /.well-known
// tvoří OAuth server (řeší si přihlášení sám) — všechny si auth řeší samy
const PUBLIC_PATHS = [
  "/login",
  "/auth",
  "/api/cron",
  "/api/inbound",
  "/api/mcp",
  "/api/oauth",
  "/oauth",
  "/.well-known",
];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // getClaims místo getUser: podpis JWT se ověří lokálně (asymetrický klíč
  // projektu), bez round-tripu na Supabase Auth při každém požadavku.
  // Prošlý access token se přitom pořád obnoví (getSession uvnitř) a nové
  // cookies se propíšou přes setAll výš.
  const jwks = staticJwks();
  const { data, error } = await supabase.auth.getClaims(
    undefined,
    jwks ? { jwks } : undefined
  );
  const signedIn = !!data?.claims?.sub;

  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  // Chvilková nedostupnost Supabase Auth (síť, JWKS na studeném startu) není
  // odhlášení — přesměrování na /login by vypadalo jako výpadek. Pustíme dál:
  // stránka si session ověří znovu a při chybě nabídne „Zkusit znovu".
  if (!signedIn && error && isAuthRetryableFetchError(error)) return response;

  if (!signedIn && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
