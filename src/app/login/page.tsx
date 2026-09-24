"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { safeNextPath } from "@/lib/safeNext";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const linkError = searchParams.get("error") === "link";
  const oauthError = searchParams.get("error") === "oauth";
  // návrat po přihlášení — jen vlastní cesta, ať to nejde zneužít k open redirectu
  const dest = safeNextPath(searchParams.get("next"));

  const [mode, setMode] = useState<"login" | "reset" | "reset-sent">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError("Přihlášení se nezdařilo. Zkontroluj e-mail a heslo.");
      setLoading(false);
      return;
    }
    router.push(dest);
    router.refresh();
  }

  /** Google (Workspace) OAuth přes Supabase — PKCE, návrat na /auth/callback. */
  async function handleGoogle() {
    setError(null);
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(dest)}`,
      },
    });
    if (error) {
      setError("Přihlášení přes Google se nepodařilo spustit.");
      setLoading(false);
    }
    // jinak prohlížeč odchází na Google — loading necháme běžet
  }

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email);
    setLoading(false);
    if (error) {
      setError("Odkaz se nepodařilo odeslat. Zkus to za chvíli znovu.");
      return;
    }
    setMode("reset-sent");
  }

  if (mode === "reset-sent") {
    return (
      <div className="w-full max-w-sm space-y-4 panel p-8 shadow-sm">
        <h1 className="font-display text-2xl font-bold">
          Kronos<span className="text-accent">.</span>
        </h1>
        <p className="text-sm">
          Pokud účet pro <span className="font-medium">{email}</span> existuje,
          poslali jsme na něj odkaz pro nastavení nového hesla.
        </p>
        <button onClick={() => setMode("login")} className="btn-ghost px-0">
          ← Zpět na přihlášení
        </button>
      </div>
    );
  }

  const isReset = mode === "reset";

  return (
    <form
      onSubmit={isReset ? handleReset : handleLogin}
      className="w-full max-w-sm space-y-4 panel p-8 shadow-sm"
    >
      <h1 className="font-display text-2xl font-bold">
        Kronos<span className="text-accent">.</span>
      </h1>
      <p className="text-sm text-ink-soft">
        {isReset
          ? "Zadej e-mail účtu a pošleme ti odkaz pro nastavení nového hesla."
          : "Přihlas se. Účet vzniká pozvánkou od admina."}
      </p>
      {linkError && !isReset && (
        <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-800">
          Odkaz z e-mailu už není platný. Přihlas se, požádej o novou pozvánku,
          nebo si nech poslat odkaz pro nastavení hesla.
        </p>
      )}
      {oauthError && !isReset && (
        <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-800">
          Přihlášení přes Google se nezdařilo. Zkus to znovu, nebo se přihlas
          e-mailem a heslem.
        </p>
      )}
      <label className="block">
        <span className="text-sm font-medium">E-mail</span>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="input mt-1 w-full px-3 py-2"
        />
      </label>
      {!isReset && (
        <label className="block">
          <span className="text-sm font-medium">Heslo</span>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input mt-1 w-full px-3 py-2"
          />
        </label>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={loading} className="btn-primary w-full justify-center">
        {loading
          ? "Pracuji…"
          : isReset
            ? "Poslat odkaz na nové heslo"
            : "Přihlásit se"}
      </button>
      {!isReset && (
        <>
          <div className="flex items-center gap-3" aria-hidden>
            <span className="h-px flex-1 bg-line" />
            <span className="text-xs text-ink-soft/60">nebo</span>
            <span className="h-px flex-1 bg-line" />
          </div>
          <button
            type="button"
            onClick={handleGoogle}
            disabled={loading}
            className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium hover:border-ink-soft/40 disabled:opacity-60"
          >
            <svg viewBox="0 0 24 24" className="h-4.5 w-4.5 shrink-0" aria-hidden>
              <path
                fill="#4285F4"
                d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.4 3.62v3h3.87c2.27-2.09 3.58-5.17 3.58-8.81z"
              />
              <path
                fill="#34A853"
                d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.87-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.29v3.1A12 12 0 0 0 12 24z"
              />
              <path
                fill="#FBBC05"
                d="M5.27 14.28A7.2 7.2 0 0 1 4.9 12c0-.79.14-1.56.37-2.28v-3.1H1.29a12 12 0 0 0 0 10.76l3.98-3.1z"
              />
              <path
                fill="#EA4335"
                d="M12 4.77c1.76 0 3.34.6 4.59 1.79l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.29 6.62l3.98 3.1C6.22 6.88 8.87 4.77 12 4.77z"
              />
            </svg>
            Pokračovat přes Google
          </button>
        </>
      )}
      <button
        type="button"
        onClick={() => {
          setError(null);
          setMode(isReset ? "login" : "reset");
        }}
        className="w-full text-center text-sm text-ink-soft hover:text-accent"
      >
        {isReset ? "← Zpět na přihlášení" : "Zapomenuté heslo?"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-paper p-4">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
