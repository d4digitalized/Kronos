// Odesílání e-mailů přes Resend (https://resend.com) — POUZE na serveru.
// Env: RESEND_API_KEY, volitelně EMAIL_FROM a NEXT_PUBLIC_APP_URL.

export const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? "https://kronos.digitalized.cz";

// display name v uvozovkách — tečka je v RFC 5322 speciální znak
const FROM = process.env.EMAIL_FROM ?? '"Kronos." <kronos@digitalized.cz>';

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  replyTo?: string
) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM,
      to,
      subject,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
    // Resend bez odpovědi nesmí zablokovat frontu notifikací
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${await res.text()}`);
  }
}

/* ---------------------------------------------------------------- odpovědi
   Odpověď na notifikační e-mail se má propsat jako komentář na kartu.
   Reply-To nese podepsaný token (task, uživatel, HMAC přes CRON_SECRET),
   inbound webhook ho ověří. Vyžaduje env REPLY_DOMAIN (Resend receiving). */

import { createHmac, timingSafeEqual } from "crypto";

/* Token musí projít e-mailovou validací: lokální část adresy smí mít
   max 64 znaků, proto binárně: 16 B task + 16 B user + 8 B HMAC
   → base64url (54 znaků) + prefix "r". */

function uuidToBytes(id: string): Buffer {
  return Buffer.from(id.replace(/-/g, ""), "hex");
}

function bytesToUuid(b: Buffer): string {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function replySignature(taskId: string, userId: string): Buffer {
  return createHmac("sha256", process.env.CRON_SECRET ?? "")
    .update(`${taskId}.${userId}`)
    .digest()
    .subarray(0, 8);
}

/** Reply-To adresa pro kartu+příjemce, nebo null když inbound není nastaven. */
export function replyAddress(taskId: string, userId: string): string | null {
  const domain = process.env.REPLY_DOMAIN;
  if (!domain || !process.env.CRON_SECRET) return null;
  const token = Buffer.concat([
    uuidToBytes(taskId),
    uuidToBytes(userId),
    replySignature(taskId, userId),
  ]).toString("base64url");
  return `r${token}@${domain}`;
}

/** Ověří a rozloží token z adresy `r<token>@…`. */
export function parseReplyAddress(
  address: string
): { taskId: string; userId: string } | null {
  // bez tajemství by prošel token podepsaný prázdným klíčem (padělek)
  if (!process.env.CRON_SECRET) return null;
  const m = address.trim().match(/^r([A-Za-z0-9_-]{54})@/);
  if (!m) return null;
  const buf = Buffer.from(m[1], "base64url");
  if (buf.length !== 40) return null;
  const taskId = bytesToUuid(buf.subarray(0, 16));
  const userId = bytesToUuid(buf.subarray(16, 32));
  const expected = replySignature(taskId, userId);
  if (!timingSafeEqual(buf.subarray(32), expected)) return null;
  return { taskId, userId };
}

/** Jednotný obal e-mailu — čistý, bez obrázků, ladí s design systémem. */
export function emailLayout(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="cs">
<body style="margin:0;padding:24px;background:#f5f6f7;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1f2328;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e5e8;border-radius:12px;padding:24px;">
    <h1 style="margin:0 0 12px;font-size:16px;">${title}</h1>
    ${bodyHtml}
    <p style="margin:20px 0 0;font-size:12px;color:#5c636b;">
      Notifikace si můžeš vypnout v <a href="${APP_URL}/settings" style="color:#0e7569;">nastavení</a>.
    </p>
  </div>
</body>
</html>`;
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
