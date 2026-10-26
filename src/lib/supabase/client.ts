import {
  combineChunks,
  createBrowserClient,
  parseCookieHeader,
  stringFromBase64URL,
} from "@supabase/ssr";
import { requestUrl, resilientFetch } from "@/lib/supabase/fetch";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
// stejný klíč cookie, jaký si supabase-js odvodí sám
const STORAGE_KEY = `sb-${new URL(SUPABASE_URL).hostname.split(".")[0]}-auth-token`;
const authFetch = resilientFetch(15_000);

function unauthorized(): Response {
  const body = { code: "PGRST301", message: "Přihlášení neplatí (dotaz bez session)", details: null, hint: null };
  return new Response(JSON.stringify(body), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

/** Refresh token uložený v cookies právě teď (čte se stejně jako v @supabase/ssr). */
async function storedRefreshToken(): Promise<string | null> {
  if (typeof document === "undefined") return null;
  const jar = new Map(parseCookieHeader(document.cookie).map((c) => [c.name, c.value]));
  const raw = await combineChunks(STORAGE_KEY, (name) => jar.get(name));
  if (!raw) return null;
  try {
    const json = raw.startsWith("base64-") ? stringFromBase64URL(raw.slice(7)) : raw;
    return (JSON.parse(json) as { refresh_token?: string }).refresh_token ?? null;
  } catch {
    return null;
  }
}

function sentRefreshToken(init?: RequestInit): string | null {
  if (typeof init?.body !== "string") return null;
  try {
    return (JSON.parse(init.body) as { refresh_token?: string }).refresh_token ?? null;
  } catch {
    return null;
  }
}

const browserFetch: typeof fetch = async (input, init) => {
  const url = requestUrl(input);

  // Obnova se starším tokenem, než je uložený: záložka probuzená ze spánku
  // uprostřed opakování (Mac uspaný ve chvíli výpadku sítě) nebo souboj
  // záložek. Supabase ho bere jako zneužití a zruší celou session (v logu
  // 21. 10.). Takový pokus neposlat — knihovna ho vezme jako výpadek
  // spojení, session nechá a příště si přečte uložený token.
  if (url.includes("/auth/v1/token") && url.includes("grant_type=refresh_token")) {
    const sent = sentRefreshToken(init);
    const stored = await storedRefreshToken();
    if (sent && stored && sent !== stored) throw new TypeError("Zastaralý pokus o obnovu tokenu");
  }

  const toData = url.includes("/rest/v1/") || url.includes("/storage/v1/");
  if (!toData) return authFetch(input, init);
  const headers = new Headers(init?.headers);

  // Bez session pošle supabase-js dotaz s anon klíčem a RLS vrátí prázdno BEZ
  // chyby — obrazovky ukážou „nic", timer nejde spustit. Stává se hlavně při
  // obnově tokenu ve dvou záložkách naráz: záložka, která souboj prohraje, má
  // session na okamžik prázdnou, i když ji druhá už uložila. Proto ji přečíst
  // znovu; teprve když opravdu není, chyba přihlášení („Zkusit znovu").
  if (headers.get("Authorization") === `Bearer ${ANON_KEY}`) {
    const { data } = await createClient().auth.getSession();
    const token = data.session?.access_token;
    if (!token) return unauthorized();
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  }

  // 401 s vlastním tokenem = server ho má za prošlý, prohlížeč ne (hned po
  // probuzení ze spánku, posunuté hodiny v počítači). Jednou vynutit obnovu
  // a zopakovat; když session opravdu není, odhlášení zachytí SessionWatcher.
  const res = await fetch(input, { ...init, headers });
  if (res.status !== 401) return res;
  const { data } = await createClient().auth.refreshSession();
  const token = data.session?.access_token;
  if (!token) return res;
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
};

/** V prohlížeči singleton (createBrowserClient ho drží sám). */
export function createClient() {
  return createBrowserClient(SUPABASE_URL, ANON_KEY, {
    global: { fetch: browserFetch },
  });
}
