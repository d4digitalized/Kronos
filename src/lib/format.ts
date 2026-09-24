export function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}`;
}

export function fmtClock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("cs-CZ", {
    weekday: "short",
    day: "numeric",
    month: "numeric",
  });
}

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("cs-CZ", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Posun hodin prohlížeče vůči databázi. started_at běžícího timeru dává
// now() serveru — s rozjetými hodinami v počítači by běžící čas stál na
// 0:00:00 (opožděné hodiny) nebo startoval s náskokem (předbíhající).
let clockOffsetMs = 0;

/** Srovná hodiny podle now() ze serveru; bere střed doby požadavku. */
export function syncServerClock(serverNowIso: string, requestStartedAt: number) {
  const received = Date.now();
  const server = new Date(serverNowIso).getTime();
  // pomalá odpověď by odhad rozmazala — takový vzorek zahodíme
  if (Number.isNaN(server) || received - requestStartedAt > 3000) return;
  clockOffsetMs = server - (requestStartedAt + received) / 2;
}

/** „Teď" v čase serveru (pro běžící záznamy). */
export function serverNow(): number {
  return Date.now() + clockOffsetMs;
}

export function entrySeconds(startedAt: string, stoppedAt: string | null): number {
  const end = stoppedAt ? new Date(stoppedAt).getTime() : serverNow();
  return Math.max(0, (end - new Date(startedAt).getTime()) / 1000);
}

/** yyyy-mm-dd v lokálním čase (klíč pro seskupení po dnech) */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
