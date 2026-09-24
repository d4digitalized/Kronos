"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";
import LoadError from "@/components/LoadError";
import type { NotificationPrefs } from "@/lib/types";

const DEFAULTS: Omit<NotificationPrefs, "user_id"> = {
  // e-mail o přiřazení je ve výchozím stavu vypnutý (viz migrace 0034)
  on_assign: false,
  on_comment: true,
  on_mention: true,
  // denní přehled taky vypnutý (viz migrace 0035)
  daily_digest: false,
};

const ITEMS: { key: keyof typeof DEFAULTS; label: string; hint: string }[] = [
  {
    key: "on_assign",
    label: "Přiřazení karty",
    hint: "E-mail, když ti někdo přiřadí kartu. Standardně vypnuto — přiřazení uvidíš u zvonečku.",
  },
  {
    key: "on_comment",
    label: "Komentáře",
    hint: "E-mail, když někdo komentuje tvoji kartu (jsi řešitel nebo autor).",
  },
  {
    key: "on_mention",
    label: "Zmínky",
    hint: "E-mail, když tě někdo označí @tagem v komentáři.",
  },
  {
    key: "daily_digest",
    label: "Denní přehled",
    hint: "Ranní souhrn karet po termínu a s termínem dnes. Standardně vypnuto.",
  },
];

export default function NotificationSettings({ userId }: { userId: string }) {
  const supabase = createClient();
  const [prefs, setPrefs] = useState(DEFAULTS);
  const [loading, setLoading] = useState(true);
  // Bez úspěšného načtení jsou vidět jen výchozí hodnoty — přepnutí by je
  // uložilo všechny a přepsalo skutečné nastavení. Proto přepínače zamčené.
  const [loadError, setLoadError] = useState(false);
  // pořadí načítání: starší odpověď nesmí přepsat novější
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const { data, error } = await supabase
      .from("notification_prefs")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (seq !== loadSeq.current) return;
    if (error) {
      setLoadError(true);
      setLoading(false);
      return;
    }
    setLoadError(false);
    if (data) {
      setPrefs({
        on_assign: data.on_assign,
        on_comment: data.on_comment,
        on_mention: data.on_mention ?? true,
        daily_digest: data.daily_digest,
      });
    }
    setLoading(false);
  }, [supabase, userId]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(key: keyof typeof DEFAULTS) {
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    const { error } = await supabase
      .from("notification_prefs")
      .upsert({ user_id: userId, ...next, updated_at: new Date().toISOString() });
    if (error) {
      setPrefs(prefs);
      toast("Uložení nastavení se nezdařilo.", "error");
    }
  }

  if (loading) return <p className="p-4 text-ink-soft/70">Načítám…</p>;

  return (
    <div className="panel">
      <h2 className="border-b border-line/70 px-4 py-2.5 text-sm font-semibold">
        E-mailové notifikace
      </h2>
      {loadError && (
        <LoadError onRetry={load} message="Nastavení notifikací se nepodařilo načíst." />
      )}
      <div className="divide-y divide-line/50">
        {ITEMS.map((item) => (
          <label
            key={item.key}
            className="flex cursor-pointer items-start gap-3 px-4 py-3"
          >
            <input
              type="checkbox"
              checked={prefs[item.key]}
              onChange={() => toggle(item.key)}
              disabled={loadError}
              className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
            />
            <span>
              <span className="block text-sm font-medium">{item.label}</span>
              <span className="block text-xs text-ink-soft/70">{item.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
