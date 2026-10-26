// Odolnější fetch pro supabase-js — sdílí ho prohlížeč, server i proxy.
//
// 1) Chvilková porucha Supabase Auth (HTTP 5xx, 429, HTML stránka z brány)
//    vypadá pro supabase-js jako „session neplatí": obnovu tokenu vzdá a
//    session smaže. Jedna 500 při hodinové obnově tokenu = odhlášení.
//    Takovou odpověď vyhodíme jako síťovou chybu — knihovna ji zopakuje a
//    session nechá být. Skutečné odmítnutí (4xx s JSON kódem, např.
//    refresh_token_already_used) projde beze změny.
// 2) Timeout na Auth: zaseklé spojení jinak drží stránku i minutu.

const AUTH_PATH = "/auth/v1/";

/** Proxy ho nastaví požadavku, když Auth neodpověděl — stránka pak obnovu
    neopakuje (dalších až 30 s čekání) a rovnou nabídne „Zkusit znovu". */
export const AUTH_UNAVAILABLE_HEADER = "x-kronos-auth-unavailable";

export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Porucha na straně Supabase, ne verdikt o session. */
function isTransient(res: Response): boolean {
  if (res.status >= 500 || res.status === 429 || res.status === 408) return true;
  // GoTrue chyby vrací vždy jako JSON; HTML = brána / CDN
  return res.status >= 400 && !(res.headers.get("content-type") ?? "").includes("json");
}

export function resilientFetch(timeoutMs: number): typeof fetch {
  return async (input, init) => {
    if (!requestUrl(input).includes(AUTH_PATH)) return fetch(input, init);
    // AbortSignal.timeout/any starší Safari (iPad) nemá — ručně
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const outer = init?.signal;
    if (outer?.aborted) controller.abort();
    else outer?.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      const res = await fetch(input, { ...init, signal: controller.signal });
      if (isTransient(res))
        throw new TypeError(`Supabase Auth je dočasně nedostupné (HTTP ${res.status})`);
      return res;
    } finally {
      clearTimeout(timer);
    }
  };
}
