"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";
import { ListSkeleton } from "@/components/Skeletons";

/** Osobní poznámkový blok (scratchpad) v Masteru — jedna plain textová
    plocha na uživatele a firmu. Soukromé (RLS), ukládá se samo:
    krátce po psaní (debounce) a při opuštění pole. */
export default function NotesView({
  wsId,
  userId,
}: {
  wsId: string;
  userId: string;
}) {
  const supabase = createClient();
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  // načtení selhalo → needitovat: autosave by uložené poznámky přepsal
  // tím, co se stihne napsat do prázdného pole
  const [loadFailed, setLoadFailed] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  // co je v DB — ať se neukládá zbytečně
  const savedRef = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("user_notes")
      .select("content")
      .eq("workspace_id", wsId)
      .eq("user_id", userId)
      .maybeSingle();
    setLoadFailed(!!error);
    if (!error) {
      const text = (data?.content as string) ?? "";
      savedRef.current = text;
      setContent(text);
    }
    setLoading(false);
  }, [supabase, wsId, userId]);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(async () => {
    if (content === savedRef.current) return;
    setState("saving");
    const { error } = await supabase.from("user_notes").upsert(
      {
        workspace_id: wsId,
        user_id: userId,
        content,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,user_id" }
    );
    if (error) {
      setState("idle");
      toast("Uložení poznámek se nezdařilo.", "error");
      return;
    }
    savedRef.current = content;
    setState("saved");
  }, [supabase, wsId, userId, content]);

  // debounce: ulož ~800 ms po posledním úhozu
  useEffect(() => {
    if (loading || loadFailed) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(save, 800);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [content, loading, loadFailed, save]);

  if (loading) return <ListSkeleton />;

  if (loadFailed) {
    return (
      <p className="flex flex-wrap items-center gap-2 p-4 text-sm text-danger">
        Poznámky se nepodařilo načíst.
        <button onClick={load} className="rounded-md px-2 py-1 text-xs underline">
          Zkusit znovu
        </button>
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col space-y-3">
      <div className="flex items-center gap-2">
        <h1 className="font-display text-lg font-semibold">Poznámky</h1>
        <span className="text-xs text-ink-soft/70">
          Soukromý blok — vidíš ho jen ty. Ukládá se sám.
        </span>
        <span className="flex-1" />
        <span
          aria-live="polite"
          className={`text-xs transition-opacity ${
            state === "idle" ? "opacity-0" : "text-ink-soft/60 opacity-100"
          }`}
        >
          {state === "saving" ? "Ukládám…" : "Uloženo"}
        </span>
      </div>

      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onBlur={save}
        placeholder="Sem si piš cokoli — myšlenky, odkazy, telefony, poznámky k rozdělané práci…"
        className="input min-h-[60vh] w-full flex-1 resize-none px-3 py-2 font-mono text-sm leading-relaxed"
      />
    </div>
  );
}
