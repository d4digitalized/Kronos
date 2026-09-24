"use client";

import { useEffect } from "react";

// Po nasazení nové verze stará záložka nenajde své chunky (CardModal,
// dialog Nový úkol…) — načtení spadne s touhle chybou.
const CHUNK_ERROR =
  /Failed to load chunk|ChunkLoadError|Loading chunk|dynamically imported module|Importing a module script failed/i;
const RELOAD_KEY = "kronos:chunk-reload-at";

/** Obsah chybové hranice. Chybějící chunk (nová verze) → jednou sám obnoví
    stránku; jinak nabídne „Zkusit znovu" a obnovení stránky. */
export default function ErrorFallback({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const newVersion = CHUNK_ERROR.test(`${error?.name ?? ""} ${error?.message ?? ""}`);

  useEffect(() => {
    console.error(error);
    if (!newVersion) return;
    // nejvýš jednou za minutu — při trvalé chybě žádná smyčka reloadů
    try {
      const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
      if (Date.now() - last < 60_000) return;
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    } catch {
      return; // bez sessionStorage radši tlačítko než riziko smyčky
    }
    window.location.reload();
  }, [error, newVersion]);

  return (
    <div role="alert" className="panel mx-auto mt-8 w-full max-w-md space-y-3 p-6 text-center">
      <p className="font-medium">
        {newVersion ? "Vyšla nová verze Kronosu" : "Tohle se nepodařilo načíst"}
      </p>
      <p className="text-sm text-ink-soft">
        {newVersion
          ? "Stránku je potřeba obnovit, aby se načetla."
          : "Nejspíš jen chvilkový výpadek spojení. Běžící timer tím nic nezastaví."}
      </p>
      <div className="flex justify-center gap-2">
        {!newVersion && (
          <button onClick={() => retry()} className="btn-primary">
            Zkusit znovu
          </button>
        )}
        <button onClick={() => window.location.reload()} className="btn-ghost">
          Obnovit stránku
        </button>
      </div>
    </div>
  );
}
