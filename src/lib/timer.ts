import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { entrySeconds, fmtClock, serverNow, syncServerClock } from "@/lib/format";
import { toast } from "@/lib/toast";
import type { TimeEntry } from "@/lib/types";

export const TIMER_CHANGED_EVENT = "kronos:timer-changed";

/** id záznamu, který se teprve zakládá (optimistické zobrazení) */
export const OPTIMISTIC_ID = "optimistic";

/** Detail eventu: `running` = nový stav běžícího záznamu, když ho odesílatel
    zná (výsledek startu/stopu). Bez něj si posluchač stav přenačte. */
export type TimerChangedDetail = { running?: TimeEntry | null };

export function notifyTimerChanged(detail: TimerChangedDetail = {}) {
  window.dispatchEvent(
    new CustomEvent<TimerChangedDetail>(TIMER_CHANGED_EVENT, { detail })
  );
}

// Start/stop běží přes funkce timer_* v DB (migrace 0044): jedna atomická
// transakce a čas serveru. Dokud migrace v DB není, jede stará cesta z
// prohlížeče (jen s ošetřenými chybami).
let rpcMissing = false;
const isRpcMissing = (e: PostgrestError) =>
  e.code === "PGRST202" || e.code === "42883";

/** Přihlášení neplatí (vypršelý / ztracený token) — ne „nic neběží". */
const isAuthError = (e: PostgrestError) =>
  ["28000", "42501", "PGRST301", "PGRST302", "PGRST303"].includes(e.code) ||
  /jwt/i.test(e.message);

// supabase-js nemá timeout — zaseklé spojení (probuzení z uspání, výpadek
// Wi-Fi) by jinak drželo tlačítka zamčená donekonečna
const TIMEOUT_MS = 15_000;
function timeoutSignal(): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), TIMEOUT_MS);
  return controller.signal;
}

const ENTRY_SELECT = "*, tasks(title), projects(name)";

type RpcCurrent = { server_now: string; entry: TimeEntry | null };
type RpcStart = { server_now: string; entry: TimeEntry; previous: TimeEntry | null };
type RpcStop = { server_now: string; stopped: TimeEntry | null };

export type RunningResult =
  | { ok: true; running: TimeEntry | null }
  | { ok: false; auth: boolean };

/** Běžící timer uživatele. Chyba je chyba — NE „nic neběží", ať UI neschová
    timer, který na serveru dál běží. */
export async function fetchRunningTimer(
  supabase: SupabaseClient,
  userId: string
): Promise<RunningResult> {
  if (!rpcMissing) {
    const t0 = Date.now();
    const { data, error } = await supabase
      .rpc("timer_current")
      .abortSignal(timeoutSignal());
    if (!error) {
      const res = data as RpcCurrent;
      syncServerClock(res.server_now, t0);
      return { ok: true, running: res.entry };
    }
    if (!isRpcMissing(error)) return { ok: false, auth: isAuthError(error) };
    rpcMissing = true;
  }
  // stará cesta: bez session by dotaz prošel jako anon a RLS vrátila „nic"
  const { data: auth } = await supabase.auth.getSession();
  if (!auth.session) return { ok: false, auth: true };
  const { data, error } = await supabase
    .from("time_entries")
    .select(ENTRY_SELECT)
    .eq("user_id", userId)
    .is("stopped_at", null)
    .abortSignal(timeoutSignal())
    .maybeSingle();
  if (error) return { ok: false, auth: isAuthError(error) };
  return { ok: true, running: (data as TimeEntry | null) ?? null };
}

/** Stará cesta zastavení (bez migrace 0044). Konec aspoň 1 s po začátku —
    started_at je čas serveru a hodiny prohlížeče se můžou opožďovat. */
async function legacyStop(
  supabase: SupabaseClient,
  userId: string,
  description?: string
): Promise<{ data: TimeEntry | null; error: PostgrestError | null }> {
  const { data: running, error } = await supabase
    .from("time_entries")
    .select("id, started_at")
    .eq("user_id", userId)
    .is("stopped_at", null)
    .abortSignal(timeoutSignal())
    .maybeSingle();
  if (error) return { data: null, error };
  if (!running) return { data: null, error: null };
  const stoppedAt = new Date(
    Math.max(Date.now(), new Date(running.started_at).getTime() + 1000)
  ).toISOString();
  const { data, error: updateError } = await supabase
    .from("time_entries")
    .update({
      stopped_at: stoppedAt,
      ...(description !== undefined ? { description } : {}),
    })
    .eq("id", running.id)
    .select(ENTRY_SELECT)
    .abortSignal(timeoutSignal())
    .single();
  if (updateError) return { data: null, error: updateError };
  return { data: data as TimeEntry, error: null };
}

async function stopOnServer(
  supabase: SupabaseClient,
  userId: string,
  description?: string
): Promise<{ data: TimeEntry | null; error: PostgrestError | null }> {
  if (!rpcMissing) {
    const t0 = Date.now();
    const { data, error } = await supabase
      .rpc("timer_stop", { p_description: description ?? null })
      .abortSignal(timeoutSignal());
    if (!error) {
      const res = data as RpcStop;
      syncServerClock(res.server_now, t0);
      return { data: res.stopped, error: null };
    }
    if (!isRpcMissing(error)) return { data: null, error };
    rpcMissing = true;
  }
  return legacyStop(supabase, userId, description);
}

type StartEntry = {
  workspace_id: string;
  project_id?: string | null;
  task_id?: string | null;
  task_title?: string;
  /** jen pro okamžité zobrazení v liště, než odpoví server */
  project_name?: string | null;
  description?: string;
};

async function startOnServer(
  supabase: SupabaseClient,
  userId: string,
  entry: StartEntry
): Promise<{
  data: { entry: TimeEntry; previous: TimeEntry | null } | null;
  error: PostgrestError | null;
}> {
  if (!rpcMissing) {
    const t0 = Date.now();
    const { data, error } = await supabase
      .rpc("timer_start", {
        p_workspace: entry.workspace_id,
        p_project: entry.project_id ?? null,
        p_task: entry.task_id ?? null,
        p_description: entry.description ?? "",
      })
      .abortSignal(timeoutSignal());
    if (!error) {
      const res = data as RpcStart;
      syncServerClock(res.server_now, t0);
      return { data: { entry: res.entry, previous: res.previous }, error: null };
    }
    if (!isRpcMissing(error)) return { data: null, error };
    rpcMissing = true;
  }
  const stopped = await legacyStop(supabase, userId);
  if (stopped.error) return { data: null, error: stopped.error };
  const { data, error } = await supabase
    .from("time_entries")
    .insert({
      workspace_id: entry.workspace_id,
      project_id: entry.project_id ?? null,
      task_id: entry.task_id ?? null,
      description: entry.description ?? "",
      user_id: userId,
    })
    .select(ENTRY_SELECT)
    .abortSignal(timeoutSignal())
    .single();
  if (error) return { data: null, error };
  return { data: { entry: data as TimeEntry, previous: stopped.data }, error: null };
}

type StartResult = { ok: boolean; running: TimeEntry | null };

// dvojklik na ▶ (karta, lišta) nesmí založit dva záznamy
let startInFlight: Promise<StartResult> | null = null;

/** Zastaví případný běžící timer uživatele a spustí nový. Lišta ukáže nový
    timer hned (optimisticky), skutečný záznam dorazí s odpovědí serveru. */
export async function startTimer(
  supabase: SupabaseClient,
  userId: string,
  entry: StartEntry
): Promise<StartResult> {
  if (startInFlight) return { ok: false, running: null };
  startInFlight = doStart(supabase, userId, entry);
  try {
    return await startInFlight;
  } finally {
    startInFlight = null;
  }
}

/** Počká na rozběhnutý start — Stop kliknutý hned po ▶ musí zastavit až
    nový záznam, ne se s jeho založením minout. */
export async function startSettled(): Promise<void> {
  if (startInFlight) await startInFlight.catch(() => undefined);
}

async function doStart(
  supabase: SupabaseClient,
  userId: string,
  entry: StartEntry
): Promise<StartResult> {
  notifyTimerChanged({
    running: {
      id: OPTIMISTIC_ID,
      workspace_id: entry.workspace_id,
      user_id: userId,
      project_id: entry.project_id ?? null,
      task_id: entry.task_id ?? null,
      description: entry.description ?? "",
      started_at: new Date(serverNow()).toISOString(),
      stopped_at: null,
      tasks: entry.task_title ? { title: entry.task_title } : null,
      projects: entry.project_name ? { name: entry.project_name } : null,
    },
  });
  const { data, error } = await startOnServer(supabase, userId, entry);
  if (error || !data) {
    toast("Timer se nepodařilo spustit — zkus to prosím znovu.", "error");
    notifyTimerChanged(); // skutečný stav ze serveru
    return { ok: false, running: null };
  }
  if (data.previous) {
    toast("Předchozí timer zastaven a uložen, měřím nový.");
  } else {
    toast(entry.task_title ? `Timer běží: ${entry.task_title}` : "Timer běží.");
  }
  notifyTimerChanged({ running: data.entry });
  return { ok: true, running: data.entry };
}

/** Upraví projekt či popis záznamu (běžícího nebo právě pozastaveného). */
export async function updateRunningEntry(
  supabase: SupabaseClient,
  entryId: string,
  patch: { project_id?: string | null; description?: string }
) {
  const { error } = await supabase
    .from("time_entries")
    .update(patch)
    .eq("id", entryId)
    .abortSignal(timeoutSignal());
  if (error) toast("Změnu se nepodařilo uložit.", "error");
  notifyTimerChanged();
  return error;
}

/** Zastaví běžící timer. `description` uloží nedopsaný popis spolu se
    zastavením (undefined = beze změny). ok=false → nepovedlo se, stav je
    třeba přenačíst (to zařídí rozeslaný event). */
export async function stopRunningTimer(
  supabase: SupabaseClient,
  userId: string,
  opts?: { silent?: boolean; description?: string }
): Promise<{ ok: boolean; stopped: TimeEntry | null }> {
  const { data, error } = await stopOnServer(supabase, userId, opts?.description);
  if (error) {
    // i při pauze (silent) — chyba zastavení se nesmí ztratit
    toast("Timer se nepodařilo zastavit — zkus to prosím znovu.", "error");
    notifyTimerChanged();
    return { ok: false, stopped: null };
  }
  if (!opts?.silent) {
    toast(
      data?.stopped_at
        ? `Záznam uložen (${fmtClock(entrySeconds(data.started_at, data.stopped_at))}).`
        : "Timer už neběžel (zastavený jinde) — nic dalšího k uložení."
    );
  }
  notifyTimerChanged({ running: null });
  return { ok: true, stopped: data };
}
