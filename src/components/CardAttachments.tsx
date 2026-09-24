"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";
import { confirmDialog } from "@/lib/confirm";
import type { TaskAttachment } from "@/lib/types";

const BUCKET = "task-attachments";

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// bezpečný klíč do Storage (povolíme jen běžné znaky, zbytek na _)
function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-80);
}

export default function CardAttachments({
  taskId,
  workspaceId,
  userId,
}: {
  taskId: string;
  workspaceId: string;
  userId: string;
}) {
  const supabase = createClient();
  const [files, setFiles] = useState<TaskAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("task_attachments")
      .select("*")
      .eq("task_id", taskId)
      .order("created_at");
    // tabulka nemusí existovat před aplikací migrace — tiše degraduj
    if (error) return;
    setFiles((data as TaskAttachment[]) ?? []);
  }, [supabase, taskId]);

  useEffect(() => {
    load();
  }, [load]);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // ať jde nahrát stejný soubor znovu
    if (!file) return;
    setBusy(true);
    const path = `${workspaceId}/${taskId}/${crypto.randomUUID()}-${safeName(file.name)}`;
    const up = await supabase.storage
      .from(BUCKET)
      .upload(path, file, { contentType: file.type || undefined });
    if (up.error) {
      toast("Nahrání souboru se nezdařilo.", "error");
      setBusy(false);
      return;
    }
    const { error } = await supabase.from("task_attachments").insert({
      workspace_id: workspaceId,
      task_id: taskId,
      uploaded_by: userId,
      file_name: file.name,
      object_path: path,
      mime_type: file.type || "",
      size_bytes: file.size,
    });
    if (error) {
      // rollback objektu, ať nezůstane osiřelý
      await supabase.storage.from(BUCKET).remove([path]);
      toast("Přílohu se nepodařilo uložit.", "error");
    }
    setBusy(false);
    load();
  }

  async function download(a: TaskAttachment) {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(a.object_path, 60);
    if (error || !data) {
      toast("Odkaz ke stažení se nepodařilo vytvořit.", "error");
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener");
  }

  async function remove(a: TaskAttachment) {
    const ok = await confirmDialog({
      title: "Smazat přílohu?",
      message: `Soubor „${a.file_name}" se nenávratně smaže.`,
    });
    if (!ok) return;
    // nejdřív řádek (RLS cizí přílohu neodmítne chybou, jen nic nesmaže),
    // až pak soubor — jinak by po odmítnutí zůstal řádek bez souboru
    const { data, error } = await supabase
      .from("task_attachments")
      .delete()
      .eq("id", a.id)
      .select("id");
    if (error || !data?.length) {
      toast(
        error
          ? "Přílohu se nepodařilo smazat."
          : "Smazat přílohu může jen autor nebo admin.",
        "error"
      );
      return;
    }
    const { error: storageError } = await supabase.storage
      .from(BUCKET)
      .remove([a.object_path]);
    if (storageError)
      toast("Příloha je odebraná, ale soubor se nepodařilo smazat z úložiště.", "error");
    load();
  }

  return (
    <div className="space-y-1.5 border-t border-line/70 pt-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">Přílohy</h3>
        {files.length > 0 && (
          <span className="text-xs font-normal text-ink-soft/70">
            {files.length}
          </span>
        )}
        <span className="flex-1" />
        <button
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="rounded-md px-2 py-0.5 text-xs text-ink-soft/80 hover:bg-black/5 disabled:opacity-50"
        >
          {busy ? "Nahrávám…" : "+ Příloha"}
        </button>
        <input
          ref={inputRef}
          type="file"
          onChange={onPick}
          className="hidden"
          aria-hidden
        />
      </div>

      {files.map((a) => (
        <div key={a.id} className="flex items-center gap-2">
          <button
            onClick={() => download(a)}
            className="min-w-0 flex-1 truncate text-left text-sm text-accent hover:underline"
            title={a.file_name}
          >
            {a.file_name}
          </button>
          <span className="shrink-0 text-xs text-ink-soft/60">
            {fmtSize(a.size_bytes)}
          </span>
          <button
            onClick={() => remove(a)}
            aria-label={`Smazat přílohu ${a.file_name}`}
            className="shrink-0 rounded px-1.5 text-xs text-ink-soft/50 hover:text-danger"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
