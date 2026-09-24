// Inbound e-maily (Resend → webhook email.received): odpověď na
// notifikační e-mail se propíše jako komentář na kartu. Adresát
// (Reply-To) nese podepsaný token, takže autora nelze podvrhnout.
// Env: RESEND_WEBHOOK_SECRET (svix signing secret), RESEND_API_KEY.

import { createHmac, timingSafeEqual } from "crypto";
import { after, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseReplyAddress } from "@/lib/email";
import { drainNotifications } from "@/lib/notify-drain";

/** Svix podpis: HMAC-SHA256(base64 klíč, "{id}.{timestamp}.{payload}"). */
function verifySvix(headers: Headers, payload: string): boolean {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return false;
  const id = headers.get("svix-id");
  const ts = headers.get("svix-timestamp");
  const sigs = headers.get("svix-signature");
  if (!id || !ts || !sigs) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key)
    .update(`${id}.${ts}.${payload}`)
    .digest("base64");
  return sigs.split(" ").some((entry) => {
    const value = entry.split(",")[1] ?? "";
    const a = Buffer.from(value);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

/** Z odpovědi odřízne citovanou původní zprávu a podpis. */
function extractReply(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (
      /^>/.test(line) ||
      /^(On .* wrote:|Dne .* napsal\(?a?\)?:?)/i.test(line) ||
      /^-{2,}\s*(Original Message|Původní zpráva)/i.test(line) ||
      /^-{2,}\s*$/.test(line) || // standardní oddělovač podpisu „-- “
      /^_{5,}\s*$/.test(line) ||
      /^(Odesláno z |Sent from my |Get Outlook for )/i.test(line) ||
      /^(S pozdravem|S přátelským pozdravem|Best regards|Kind regards|S úctou)[,.!]?\s*$/i.test(line) ||
      /^Od:\s/.test(line) ||
      /^From:\s/.test(line)
    ) {
      break;
    }
    kept.push(line);
  }
  return kept.join("\n").trim().slice(0, 5000);
}

export async function POST(req: Request) {
  const payload = await req.text();
  if (!verifySvix(req.headers, payload)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const event = JSON.parse(payload);
  if (event.type !== "email.received") {
    return NextResponse.json({ ignored: event.type });
  }

  const addresses: string[] = [
    ...(event.data?.to ?? []),
    ...(event.data?.received_for ?? []),
  ];
  let token: { taskId: string; userId: string } | null = null;
  for (const address of addresses) {
    token = parseReplyAddress(String(address));
    if (token) break;
  }
  if (!token) return NextResponse.json({ ignored: "no-reply-token" });

  // plné tělo e-mailu (webhook nese jen metadata)
  const emailRes = await fetch(
    `https://api.resend.com/emails/receiving/${event.data.email_id}`,
    { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } }
  );
  if (!emailRes.ok) {
    console.error("inbound: fetch email failed", emailRes.status);
    return new Response("Upstream error", { status: 502 });
  }
  const email = await emailRes.json();
  const body = extractReply(
    email.text ?? String(email.html ?? "").replace(/<[^>]+>/g, " ")
  );
  if (!body) return NextResponse.json({ ignored: "empty-body" });

  const supabase = createAdminClient();
  const { data: task } = await supabase
    .from("tasks")
    .select("id, workspace_id")
    .eq("id", token.taskId)
    .maybeSingle();
  if (!task) return NextResponse.json({ ignored: "task-gone" });

  // odesílatel musí být stále členem workspace
  const { data: member } = await supabase
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", task.workspace_id)
    .eq("user_id", token.userId)
    .maybeSingle();
  if (!member) return NextResponse.json({ ignored: "not-a-member" });

  // Webhook se doručuje „aspoň jednou" — při pomalé nebo chybné odpovědi ho
  // Resend (svix) pošle znovu. Stejný text od stejného autora na téže kartě
  // za posledních 24 h proto podruhé nezakládáme.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: dup } = await supabase
    .from("task_comments")
    .select("id")
    .eq("task_id", task.id)
    .eq("author_id", token.userId)
    .eq("body", body)
    .gte("created_at", since)
    .limit(1);
  if (dup?.length) return NextResponse.json({ ignored: "duplicate" });

  const { error } = await supabase.from("task_comments").insert({
    workspace_id: task.workspace_id,
    task_id: task.id,
    author_id: token.userId,
    body,
  });
  if (error) {
    console.error("inbound: insert comment failed", error);
    return new Response("Insert failed", { status: 500 });
  }
  // komentář založil notifikace → e-maily ostatním až po odpovědi webhooku
  // (odesílání trvá; pomalá odpověď = opakované doručení)
  after(async () => {
    try {
      await drainNotifications();
    } catch (err) {
      console.error("inbound: drain failed", err);
    }
  });
  return NextResponse.json({ ok: true });
}
