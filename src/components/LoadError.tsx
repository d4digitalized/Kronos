"use client";

/** Chyba načtení ≠ prázdný seznam. Když jsou vidět starší data (`stale`),
    jen tenký pruh nad nimi; bez dat hláška místo obsahu. Obojí s „Zkusit
    znovu" — dřív obrazovka ukázala „Nemáš žádné úkoly" a vypadalo to jako
    výpadek nebo ztráta dat. */
export default function LoadError({
  onRetry,
  message = "Data se nepodařilo načíst.",
  stale = false,
}: {
  onRetry: () => void;
  message?: string;
  /** vidět zůstávají dříve načtená data */
  stale?: boolean;
}) {
  return (
    <p
      role="alert"
      className={`flex flex-wrap items-center gap-2 text-sm text-danger ${
        stale ? "rounded-lg bg-danger/10 px-3 py-1.5" : "p-4"
      }`}
    >
      {stale ? `${message} Ukazuji poslední známý stav.` : message}
      <button onClick={onRetry} className="rounded-md px-2 py-1 text-xs underline">
        Zkusit znovu
      </button>
    </p>
  );
}
