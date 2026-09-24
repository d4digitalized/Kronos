import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getOAuthClient } from "@/lib/mcp/oauth";

// OAuth authorize (consent). Uživatele autentizuje stávající Supabase login;
// pak explicitně potvrdí přístup (souhlas brání authorization-code injection).
// Formulář POSTuje na /api/oauth/authorize, které vydá kód a přesměruje zpět.

export const dynamic = "force-dynamic";

function first(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

// Jméno klienta si volí sám (kdokoli může zaregistrovat „Claude") — souhlas
// proto ukazuje, KAM se po povolení přístup předá, a varuje u cizí adresy.
const TRUSTED_HOST = /(^|.)claude.(ai|com)$|^localhost$|^127.0.0.1$|^[::1]$/;

function redirectTarget(uri: string): { host: string; trusted: boolean } {
  try {
    const url = new URL(uri);
    return { host: url.host, trusted: TRUSTED_HOST.test(url.hostname) };
  } catch {
    return { host: uri, trusted: false };
  }
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-paper p-4">
      <div className="w-full max-w-sm space-y-4 panel p-8 shadow-sm">{children}</div>
    </main>
  );
}

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const p = {
    response_type: first(sp.response_type),
    client_id: first(sp.client_id),
    redirect_uri: first(sp.redirect_uri),
    code_challenge: first(sp.code_challenge),
    code_challenge_method: first(sp.code_challenge_method),
    state: first(sp.state),
    scope: first(sp.scope),
    resource: first(sp.resource),
  };

  // validace klienta a parametrů — chyby ukazujeme uživateli, neredirectujeme
  const client = p.client_id ? await getOAuthClient(p.client_id) : null;
  let error: string | null = null;
  if (p.response_type !== "code") error = "Nepodporovaný response_type – očekává se code.";
  else if (!p.code_challenge || p.code_challenge_method !== "S256")
    error = "Chybí PKCE – code_challenge s metodou S256.";
  else if (!client) error = "Neznámý klient (client_id).";
  else if (!client.redirect_uris.includes(p.redirect_uri))
    error = "redirect_uri neodpovídá registraci klienta.";

  if (error || !client) {
    return (
      <Card>
        <h1 className="font-display text-lg font-semibold">Autorizace selhala</h1>
        <p className="text-sm text-ink-soft">{error}</p>
      </Card>
    );
  }

  // přihlášení přes Supabase; když není, návrat sem po loginu
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    const self = "/oauth/authorize?" + new URLSearchParams(p).toString();
    redirect("/login?next=" + encodeURIComponent(self));
  }

  const target = redirectTarget(p.redirect_uri);

  return (
    <Card>
      <h1 className="font-display text-lg font-semibold">Povolit přístup</h1>
      <p className="text-sm text-ink-soft">
        <span className="font-medium">{client.client_name}</span> žádá o přístup k
        tvému účtu Kronos<span className="text-accent">.</span> (
        <span className="font-medium">{user.email}</span>). Bude
        moci pod tvým jménem číst a zakládat úkoly, přiřazovat řešitele a komentovat —
        jen v projektech, které sám vidíš.
      </p>
      <p className={`text-sm ${target.trusted ? "text-ink-soft" : "text-danger"}`}>
        Přístup dostane: <span className="font-mono font-medium">{target.host}</span>
        {!target.trusted &&
          " — neznámá adresa. Povol jen, pokud napojení právě sám zakládáš."}
      </p>
      <form method="post" action="/api/oauth/authorize" className="space-y-3">
        {Object.entries(p).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <div className="flex gap-2">
          <button
            type="submit"
            name="action"
            value="approve"
            className="btn-primary flex-1 justify-center"
          >
            Povolit
          </button>
          <button
            type="submit"
            name="action"
            value="deny"
            className="btn-ghost flex-1 justify-center"
          >
            Odmítnout
          </button>
        </div>
      </form>
    </Card>
  );
}
