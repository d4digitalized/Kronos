/** Návrat po přihlášení jen na vlastní cestu. Samotné startsWith("/") a
    ne-"//" nestačí: „/\evil.com" nebo „/<TAB>/evil.com" prohlížeč vyhodnotí
    jako cizí doménu (open redirect pro phishing přes přihlašovací odkaz). */
export function safeNextPath(next: string | null): string {
  if (!next || !next.startsWith("/")) return "/";
  const base = "https://kronos.invalid";
  try {
    const url = new URL(next, base);
    if (url.origin !== base) return "/";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/";
  }
}
