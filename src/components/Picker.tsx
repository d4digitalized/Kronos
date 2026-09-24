"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type PickerOption = {
  id: string | null;
  label: string;
  /** Barva tečky před názvem; null = prázdná (obrysová) tečka, undefined = bez tečky. */
  dot?: string | null;
  /** Vlastní vizuál před názvem (např. Avatar). Má přednost před tečkou/ikonou. */
  avatar?: ReactNode;
  /** Nabídne se až po zadání aspoň jednoho znaku (např. duchové/kontakty). */
  deferred?: boolean;
};

export default function Picker({
  options,
  value,
  onChange,
  placeholder,
  iconPath,
  ariaLabel,
  align = "right",
  disabled = false,
  hideLabelOnMobile = false,
  alwaysSearch = false,
  onCreate,
  createLabel = "založit",
}: {
  options: PickerOption[];
  value: string | null;
  onChange: (id: string | null) => void;
  placeholder: string;
  iconPath: string;
  ariaLabel: string;
  align?: "left" | "right";
  disabled?: boolean;
  /** Na mobilu jen ikona/tečka — šetří místo v úzké liště. */
  hideLabelOnMobile?: boolean;
  /** Hledací pole vždy (jinak až od 8 možností). */
  alwaysSearch?: boolean;
  /** Když dotaz nesedí na žádnou možnost, nabídne na konci „➕ createLabel „dotaz"". */
  onCreate?: (query: string) => void;
  createLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.id !== null && o.id === value) ?? null;
  const showSearch = alwaysSearch || options.length > 7;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    // prázdné hledání = jen „základní" možnosti (duchové/kontakty se objeví
    // až po prvním znaku); s dotazem filtrujeme podle názvu napříč vším
    if (!q) return options.filter((o) => !o.deferred);
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  // „➕ založit" jen když je co zakládat a dotaz přesně nesedí na existující
  const trimmed = query.trim();
  const canCreate =
    !!onCreate &&
    trimmed.length > 0 &&
    !options.some((o) => o.label.toLowerCase() === trimmed.toLowerCase());

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    searchRef.current?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Esc zavře jen nabídku — karta/dialog pod ní ho ignoruje
      // (defaultPrevented) a na window se už nedostane
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pick(id: string | null) {
    onChange(id);
    setOpen(false);
  }

  function create() {
    onCreate?.(trimmed);
    setOpen(false);
  }

  // „➕ založit" se chová jako poslední položka seznamu (index visible.length)
  const lastIndex = visible.length - 1 + (canCreate ? 1 : 0);

  function onListKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, lastIndex));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (visible[active]) pick(visible[active].id);
      else if (canCreate && active >= visible.length) create();
      else if (canCreate && visible.length === 0) create();
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={`flex max-w-52 items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          selected
            ? "text-ink hover:bg-black/5"
            : "text-ink-soft/70 hover:bg-black/5 hover:text-ink-soft"
        }`}
      >
        {selected?.avatar !== undefined && selected ? (
          selected.avatar
        ) : selected?.dot !== undefined && selected ? (
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ background: selected.dot ?? undefined }}
            aria-hidden
          />
        ) : (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4 shrink-0"
            aria-hidden
          >
            <path d={iconPath} />
          </svg>
        )}
        <span
          className={`min-w-0 truncate ${hideLabelOnMobile ? "hidden sm:inline" : ""}`}
        >
          {selected ? selected.label : placeholder}
        </span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`h-3 w-3 shrink-0 text-ink-soft/60 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          className={`absolute top-full z-50 mt-1.5 w-64 overflow-hidden rounded-xl border border-line bg-surface shadow-lg ${
            align === "right" ? "right-0" : "left-0"
          }`}
          onKeyDown={onListKeyDown}
        >
          {showSearch && (
            <div className="border-b border-line/70 p-2">
              <input
                ref={searchRef}
                type="text"
                placeholder="Hledat…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                className="w-full input px-2 py-1"
              />
            </div>
          )}
          <ul role="listbox" aria-label={ariaLabel} className="max-h-72 overflow-y-auto p-1">
            {visible.length === 0 && !canCreate && (
              <li className="px-2.5 py-2 text-sm text-ink-soft/70">
                Nic nenalezeno.
              </li>
            )}
            {visible.map((opt, i) => {
              const isSelected = opt.id === value;
              return (
                <li key={opt.id ?? "none"} role="option" aria-selected={isSelected}>
                  <button
                    type="button"
                    onClick={() => pick(opt.id)}
                    onMouseEnter={() => setActive(i)}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm ${
                      i === active ? "bg-accent-soft" : ""
                    } ${isSelected ? "font-medium text-accent" : "text-ink"}`}
                  >
                    {opt.avatar !== undefined ? (
                      opt.avatar
                    ) : opt.dot !== undefined ? (
                      <span
                        className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                          opt.dot === null ? "border border-ink-soft/40" : ""
                        }`}
                        style={opt.dot ? { background: opt.dot } : undefined}
                        aria-hidden
                      />
                    ) : null}
                    <span className="truncate">{opt.label}</span>
                    {isSelected && (
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="ml-auto h-3.5 w-3.5 shrink-0"
                        aria-hidden
                      >
                        <path d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </button>
                </li>
              );
            })}
            {canCreate && (
              <li role="option" aria-selected={false}>
                <button
                  type="button"
                  onClick={create}
                  onMouseEnter={() => setActive(visible.length)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-accent ${
                    active >= visible.length ? "bg-accent-soft" : ""
                  }`}
                >
                  ➕ {createLabel} „{trimmed}“
                </button>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
