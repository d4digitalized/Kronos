"use client";

import { useEffect, useRef, useState } from "react";
import { TOAST_EVENT, type ToastDetail } from "@/lib/toast";

type Item = ToastDetail & { id: number };

export default function Toaster() {
  const [items, setItems] = useState<Item[]>([]);
  const counter = useRef(0);

  useEffect(() => {
    function onToast(e: Event) {
      const detail = (e as CustomEvent<ToastDetail>).detail;
      const id = ++counter.current;
      setItems((prev) => [...prev, { ...detail, id }]);
      setTimeout(() => {
        setItems((prev) => prev.filter((t) => t.id !== id));
      }, 4000);
    }
    window.addEventListener(TOAST_EVENT, onToast);
    return () => window.removeEventListener(TOAST_EVENT, onToast);
  }, []);

  if (items.length === 0) return null;

  return (
    <div
      aria-live="polite"
      // nad focus módem (z-[100]) — chyba zastavení tam musí být vidět
      className="fixed bottom-4 left-1/2 z-[110] flex w-full max-w-sm -translate-x-1/2 flex-col gap-2 px-4"
    >
      {items.map((item) => (
        <div
          key={item.id}
          role="status"
          className={`rounded-lg px-3 py-2 text-sm text-white shadow-lg ${
            item.kind === "error" ? "bg-red-700" : "bg-ink"
          }`}
        >
          {item.message}
        </div>
      ))}
    </div>
  );
}
