// Google Calendar přes service account s domain-wide delegation.
// POUZE na serveru. Env: GOOGLE_SA_EMAIL, GOOGLE_SA_PRIVATE_KEY (PEM,
// \n escapované), GOOGLE_WORKSPACE_DOMAIN (např. "denular.com").
// Server se vydává za uživatele Workspace (sub = jeho e-mail) a pracuje
// s jeho kalendáři, žádné per-user tokeny se neskladují.

import { createSign } from "crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/calendar";
const API = "https://www.googleapis.com/calendar/v3";
const TZ = "Europe/Prague";
// Google bez odpovědi nesmí držet server action (karta, Můj den) do limitu
// platformy — po 10 s radši chyba, kterou UI ohlásí
const TIMEOUT_MS = 10_000;

export function googleConfigured(): boolean {
  return !!(process.env.GOOGLE_SA_EMAIL && process.env.GOOGLE_SA_PRIVATE_KEY);
}

/** Doména Workspace — jen účty v ní jde impersonovat. */
export function workspaceDomain(): string {
  return process.env.GOOGLE_WORKSPACE_DOMAIN ?? "denular.com";
}

function b64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

/** PEM klíč z env — snese uvozovky na krajích i \n escapy z JSONu. */
function privateKey(): string {
  let k = process.env.GOOGLE_SA_PRIVATE_KEY!.trim();
  if (
    (k.startsWith('"') && k.endsWith('"')) ||
    (k.startsWith("'") && k.endsWith("'"))
  ) {
    k = k.slice(1, -1);
  }
  return k.replace(/\\n/g, "\n").trim();
}

// Token platí hodinu: v teplé instanci ho znovu nevyměňovat — dřív každé
// volání Calendar API (3 na řešitele) stálo navíc výměnu tokenu.
const tokenCache = new Map<string, { token: string; exp: number }>();

/** Access token pro jednání jménem uživatele (JWT bearer flow). */
async function accessToken(userEmail: string): Promise<string> {
  const cached = tokenCache.get(userEmail);
  if (cached && cached.exp - Date.now() > 60_000) return cached.token;
  const iss = process.env.GOOGLE_SA_EMAIL!.trim();
  const key = privateKey();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss,
      sub: userEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const assertion = `${header}.${payload}.${signer.sign(key, "base64url")}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`google token ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in?: number };
  tokenCache.set(userEmail, {
    token: json.access_token,
    exp: Date.now() + (json.expires_in ?? 3600) * 1000,
  });
  return json.access_token;
}

async function gfetch(
  userEmail: string,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const token = await accessToken(userEmail);
  return fetch(`${API}${path}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

/** Název kalendáře: „{jméno vlastníka} - KRONOS" (přípona jde přebít env
    GOOGLE_CALENDAR_NAME). */
export function calendarName(owner?: string | null): string {
  const suffix = process.env.GOOGLE_CALENDAR_NAME ?? "KRONOS";
  return owner ? `${owner} - ${suffix}` : suffix;
}

/** Založí uživateli sekundární plánovací kalendář a vrátí jeho id. */
export async function createKronosCalendar(
  userEmail: string,
  ownerName?: string | null
): Promise<string> {
  const res = await gfetch(userEmail, "/calendars", {
    method: "POST",
    body: JSON.stringify({ summary: calendarName(ownerName), timeZone: TZ }),
  });
  if (!res.ok) {
    throw new Error(`create calendar ${res.status}: ${await res.text()}`);
  }
  return (await res.json()).id as string;
}

export type CalendarEventInput = {
  summary: string;
  description?: string;
  start: string; // ISO
  end: string; // ISO
};

/** Založí či přepíše událost; vrací id události. Ztracenou (smazanou)
    událost zakládá znovu. */
export async function upsertEvent(
  userEmail: string,
  calendarId: string,
  eventId: string | null,
  ev: CalendarEventInput
): Promise<string> {
  const body = JSON.stringify({
    summary: ev.summary,
    description: ev.description ?? "",
    start: { dateTime: ev.start, timeZone: TZ },
    end: { dateTime: ev.end, timeZone: TZ },
  });
  if (eventId) {
    const res = await gfetch(
      userEmail,
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: "PUT", body }
    );
    if (res.ok) return eventId;
    if (res.status !== 404 && res.status !== 410) {
      throw new Error(`update event ${res.status}: ${await res.text()}`);
    }
    // událost mezitím zmizela → založit znovu
  }
  const res = await gfetch(
    userEmail,
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    { method: "POST", body }
  );
  if (!res.ok) {
    throw new Error(`insert event ${res.status}: ${await res.text()}`);
  }
  return (await res.json()).id as string;
}

/** Smaže událost; už smazanou tiše přejde. */
export async function deleteEvent(
  userEmail: string,
  calendarId: string,
  eventId: string
): Promise<void> {
  const res = await gfetch(
    userEmail,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE" }
  );
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`delete event ${res.status}: ${await res.text()}`);
  }
}
