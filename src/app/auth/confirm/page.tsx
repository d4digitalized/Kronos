import { redirect } from "next/navigation";
import { confirmEmailLink } from "./actions";

// Cíl odkazu z e-mailu (pozvánka, obnova hesla). Vyžaduje upravené e-mail
// šablony v Supabase: .../auth/confirm?token_hash={{ .TokenHash }}&type=...
//
// Token se ověřuje až tlačítkem (POST), ne při otevření odkazu: firemní
// kontrola odkazů v e-mailech (Outlook Safe Links, antiviry) odkaz otevře
// dřív než člověk a jednorázový token by „spálila" — pozvánka pak hlásila,
// že odkaz už neplatí.

export const dynamic = "force-dynamic";

export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const tokenHash = typeof sp.token_hash === "string" ? sp.token_hash : "";
  const type = typeof sp.type === "string" ? sp.type : "";
  if (!tokenHash || !type) redirect("/login?error=link");
  const recovery = type === "recovery";

  return (
    <main className="flex min-h-screen items-center justify-center bg-paper p-4">
      <form
        action={confirmEmailLink}
        className="w-full max-w-sm space-y-4 panel p-8 shadow-sm"
      >
        <h1 className="font-display text-lg font-semibold">
          {recovery ? "Obnova hesla" : "Vítej v Kronosu"}
          <span className="text-accent">.</span>
        </h1>
        <p className="text-sm text-ink-soft">
          {recovery
            ? "Pokračuj a nastav si nové heslo."
            : "Pokračuj a dokonči pozvánku — nastavíš si heslo."}
        </p>
        <input type="hidden" name="token_hash" value={tokenHash} />
        <input type="hidden" name="type" value={type} />
        <button type="submit" className="btn-primary w-full justify-center">
          Pokračovat
        </button>
      </form>
    </main>
  );
}
