"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ElapsedClock from "@/components/ElapsedClock";
import type { TimeEntry } from "@/lib/types";

const THEME_KEY = "kronos:focus-theme";

/** Celoobrazovkový focus mode (iPad na stole): jen úkol, velký čas a
    Pauza / Stop. Černá nebo bílá — volba se pamatuje v prohlížeči.
    Snaží se o skutečný fullscreen a drží obrazovku vzhůru (wake lock);
    obojí best-effort, kde to prohlížeč neumí, zůstane aspoň overlay. */
export default function FocusMode({
  running,
  accumSeconds,
  taskTitle,
  description,
  projectName,
  busy,
  onPause,
  onResume,
  onStop,
  onClose,
  onSaveDescription,
}: {
  running: TimeEntry | null;
  /** sečtené dřívější úseky téhle seance (před pauzami) */
  accumSeconds: number;
  /** název karty, když timer běží na úkolu; jinak null */
  taskTitle: string | null;
  description: string;
  projectName: string | null;
  busy: boolean;
  /** pauza/stop/zavření dostanou i rozepsanou poznámku — na iPadu klepnutí
      na tlačítko pole neopustí, takže by se uložení na blur nespustilo */
  onPause: (note: string) => void;
  onResume: () => void;
  onStop: (note: string) => void;
  onClose: (note: string) => void;
  onSaveDescription: (text: string) => void;
}) {
  const [dark, setDark] = useState(true);
  // rozepsaný popis — ukládá se při opuštění pole / Enterem
  const [draft, setDraft] = useState(description);
  // aktuální text i pro Esc listener (bez re-subscribe na každý znak)
  const draftRef = useRef(description);
  useEffect(() => {
    setDraft(description);
    draftRef.current = description;
  }, [description]);
  function editDraft(value: string) {
    setDraft(value);
    draftRef.current = value;
  }

  useEffect(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved) setDark(saved !== "light");
    } catch {}
  }, []);

  function toggleTheme() {
    setDark((d) => {
      try {
        localStorage.setItem(THEME_KEY, d ? "light" : "dark");
      } catch {}
      return !d;
    });
  }

  // skutečný fullscreen (iPadOS 16.4+ ho na Safari umí) — best effort
  useEffect(() => {
    const el = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void>;
    };
    try {
      (el.requestFullscreen ?? el.webkitRequestFullscreen)?.call(el)?.catch?.(() => {});
    } catch {}
    return () => {
      try {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      } catch {}
    };
  }, []);

  // wake lock: ať iPad při běžícím timeru nezhasne; po probuzení znovu
  useEffect(() => {
    type Lock = { release: () => Promise<void> } | null;
    let lock: Lock = null;
    let disposed = false;
    async function acquire() {
      try {
        const wl = (navigator as Navigator & {
          wakeLock?: { request: (t: "screen") => Promise<NonNullable<Lock>> };
        }).wakeLock;
        if (!wl) return;
        lock = await wl.request("screen");
      } catch {}
    }
    const onVisible = () => {
      if (document.visibilityState === "visible" && !disposed) acquire();
    };
    acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisible);
      lock?.release().catch(() => {});
    };
  }, []);

  // Esc zavře focus mode (první Esc případně ukončí fullscreen prohlížeče)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose(draftRef.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const paused = !running;
  const frame = dark ? "bg-black text-white" : "bg-white text-black";
  const soft = dark ? "text-white/50" : "text-black/50";
  const ghostBtn = `rounded-full border px-4 py-2 text-sm transition-colors ${
    dark
      ? "border-white/25 text-white/80 hover:border-white/60"
      : "border-black/25 text-black/70 hover:border-black/60"
  }`;

  // portál do <body>: lišta je sticky se z-40 (vlastní stacking context),
  // uvnitř ní by overlay překrýval obsah stránky
  return createPortal(
    <div
      className={`fixed inset-0 z-[100] flex flex-col ${frame}`}
      role="dialog"
      aria-modal="true"
      aria-label="Focus mode"
    >
      {/* střed: projekt, úkol, čas */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        {projectName && (
          <p className={`text-sm sm:text-base ${soft}`}>{projectName}</p>
        )}
        {/* úkol je hlavní sdělení — větší než hodiny. Bez karty jde popis
            psát rovnou tady, u karty je pod názvem menší pole na poznámku. */}
        {taskTitle ? (
          <>
            <p className="max-w-5xl text-[clamp(2rem,8vw,5rem)] font-semibold leading-tight">
              {taskTitle}
            </p>
            <input
              type="text"
              value={draft}
              onChange={(e) => editDraft(e.target.value)}
              onBlur={() => onSaveDescription(draft)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  e.stopPropagation();
                  e.currentTarget.blur();
                }
              }}
              placeholder="doplnit poznámku…"
              aria-label="Poznámka k záznamu"
              className={`w-full max-w-2xl bg-transparent text-center text-lg outline-none sm:text-xl ${soft} placeholder:opacity-40`}
            />
          </>
        ) : (
          <input
            type="text"
            value={draft}
            onChange={(e) => editDraft(e.target.value)}
            onBlur={() => onSaveDescription(draft)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                e.stopPropagation();
                e.currentTarget.blur();
              }
            }}
            placeholder="Na čem děláš?"
            aria-label="Na čem děláš"
            className="w-full max-w-5xl bg-transparent text-center text-[clamp(2rem,8vw,5rem)] font-semibold leading-tight outline-none placeholder:opacity-30"
          />
        )}
        <p
          className={`font-mono text-[clamp(1.75rem,5vw,3.5rem)] font-semibold leading-none tabular-nums ${
            paused ? "opacity-40" : soft
          }`}
        >
          <ElapsedClock
            startedAt={running?.started_at ?? null}
            accumSeconds={accumSeconds}
          />
        </p>
        <p className={`h-6 text-sm uppercase tracking-[0.3em] ${soft}`}>
          {paused ? "pauza" : ""}
        </p>
      </div>

      {/* ovládání: pauza/pokračovat + stop */}
      <div className="flex items-center justify-center gap-8 pb-4 sm:pb-6">
        <button
          onClick={() => (paused ? onResume() : onPause(draft))}
          disabled={busy}
          aria-label={paused ? "Pokračovat v měření" : "Pozastavit měření"}
          className={`flex h-20 w-20 items-center justify-center rounded-full border-2 transition-colors disabled:opacity-50 ${
            dark
              ? "border-white/40 text-white hover:border-white"
              : "border-black/40 text-black hover:border-black"
          }`}
        >
          {paused ? (
            <svg viewBox="0 0 24 24" fill="currentColor" className="ml-1 h-8 w-8" aria-hidden>
              <path d="M7 4.5v15l13-7.5z" />
            </svg>
          ) : (
            <span className="flex gap-1.5" aria-hidden>
              <span className="block h-7 w-2 rounded-sm bg-current" />
              <span className="block h-7 w-2 rounded-sm bg-current" />
            </span>
          )}
        </button>
        <button
          onClick={() => onStop(draft)}
          aria-busy={busy}
          aria-label="Zastavit a uložit záznam"
          className={`flex h-20 w-20 items-center justify-center rounded-full bg-red-600 text-white shadow-lg transition-colors hover:bg-red-500 ${
            busy ? "opacity-50" : ""
          }`}
        >
          <span className="block h-7 w-7 rounded-[3px] bg-current" aria-hidden />
        </button>
      </div>

      {/* spodní lišta: motiv + zavřít — nahoře nemá nic rušit */}
      <div className="flex items-center justify-between p-4 sm:p-6">
        <button
          onClick={toggleTheme}
          aria-label={dark ? "Přepnout na bílou" : "Přepnout na černou"}
          className={ghostBtn}
        >
          {dark ? "☀ bílá" : "● černá"}
        </button>
        <button
          onClick={() => onClose(draft)}
          aria-label="Zavřít focus mode"
          className={ghostBtn}
        >
          ✕
        </button>
      </div>
    </div>,
    document.body
  );
}
