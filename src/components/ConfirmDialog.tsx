"use client";

import { useEffect, useRef, useState } from "react";
import { CONFIRM_EVENT, type ConfirmDetail } from "@/lib/confirm";

/** Hostitel vlastního potvrzovacího dialogu. Mountuje se jednou v layoutu. */
export default function ConfirmDialog() {
  const [pending, setPending] = useState<ConfirmDetail | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    function onConfirm(e: Event) {
      setPending((e as CustomEvent<ConfirmDetail>).detail);
    }
    window.addEventListener(CONFIRM_EVENT, onConfirm);
    return () => window.removeEventListener(CONFIRM_EVENT, onConfirm);
  }, []);

  // Fokus na potvrzovací tlačítko po otevření. Esc chytáme hned na window
  // (capture): patří jen dialogu — karta ani dialog pod ním se nesmí zavřít,
  // a to ani když fokus z dialogu utekl (klik do textu).
  useEffect(() => {
    if (!pending) return;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      pending.resolve(false);
      setPending(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending]);

  if (!pending) return null;

  function close(ok: boolean) {
    pending?.resolve(ok);
    setPending(null);
  }

  const danger = pending.danger ?? true;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
      onClick={() => close(false)}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        className="w-full max-w-sm space-y-4 rounded-xl bg-surface p-5 shadow-xl outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-title" className="text-lg font-semibold text-ink">
          {pending.title ?? "Opravdu?"}
        </h2>
        <p id="confirm-message" className="text-sm text-ink-soft">
          {pending.message}
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={() => close(false)}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-black/5"
          >
            {pending.cancelLabel ?? "Zrušit"}
          </button>
          <button
            ref={confirmRef}
            onClick={() => close(true)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium text-white shadow-sm ${
              danger
                ? "bg-danger hover:brightness-110"
                : "bg-accent hover:brightness-110"
            }`}
          >
            {pending.confirmLabel ?? "Smazat"}
          </button>
        </div>
      </div>
    </div>
  );
}
