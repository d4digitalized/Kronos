import { createServerClient } from "@supabase/ssr";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { staticJwks } from "@/lib/jwks";
import { safeNextPath } from "@/lib/safeNext";
import { AUTH_UNAVAILABLE_HEADER, resilientFetch } from "@/lib/supabase/fetch";

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

// Obnova tokenu při výpadku Auth jinak běží s opakováním ~30 s (a bez
// timeoutu i déle) — stránka by do té doby visela.
const AUTH_BUDGET_MS = 8_000;
const authFetch = resilientFetch(5_000);

export async function proxy(request: NextRequest) {
  // značku dává jen proxy, ne klient
  request.headers.delete(AUTH_UNAVAILABLE_HEADER);
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { fetch: authFetch },
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
  const result = await Promise.race([
    supabase.auth.getClaims(undefined, jwks ? { jwks } : undefined),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), AUTH_BUDGET_MS)),
  ]);
  const signedIn = !!result?.data?.claims?.sub;

  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  // Chvilková nedostupnost Supabase Auth (síť, 5xx, 429, JWKS na studeném
  // startu, nebo nestihl odpovědět) není odhlášení — přesměrování na /login
  // by vypadalo jako výpadek. Pustíme dál se značkou: stránka obnovu
  // neopakuje a nabídne „Zkusit znovu".
  const authDown = !result || (result.error && isAuthRetryableFetchError(result.error));
  if (!signedIn && authDown) {
    request.headers.set(AUTH_UNAVAILABLE_HEADER, "1");
    return NextResponse.next({ request });
  }

  // Přihlášený na /login (F5, záložka, zpět) rovnou dál. Jinak to vypadá, že
  // přihlášení „nefunguje" — v logu 5 úspěšných přihlášení za 47 s.
  if (signedIn && pathname === "/login") {
    const next = safeNextPath(request.nextUrl.searchParams.get("next"));
    const target = next.startsWith("/login") ? "/" : next; // žádná smyčka
    const redirect = NextResponse.redirect(new URL(target, request.url));
    // obnovený token z téhož požadavku nesmí přesměrování zahodit
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    return redirect;
  }

  if (!signedIn && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    // po přihlášení zpátky tam, kde byl (otevřená karta, odkaz z e-mailu)
    if (pathname !== "/" && !pathname.startsWith("/api/")) {
      const back = request.nextUrl.clone();
      back.searchParams.delete("_rsc");
      url.searchParams.set("next", back.pathname + back.search);
    }
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
