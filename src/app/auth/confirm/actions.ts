"use server";

import type { EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const TYPES: EmailOtpType[] = [
  "invite",
  "recovery",
  "signup",
  "magiclink",
  "email",
  "email_change",
];

/** Ověří jednorázový token z e-mailu (pozvánka, obnova hesla), založí
    session a pošle na nastavení hesla. Volá se až klikem na „Pokračovat". */
export async function confirmEmailLink(formData: FormData) {
  const tokenHash = String(formData.get("token_hash") ?? "");
  const type = String(formData.get("type") ?? "") as EmailOtpType;
  if (!tokenHash || !TYPES.includes(type)) redirect("/login?error=link");

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
  if (error) redirect("/login?error=link");
  redirect(type === "recovery" ? "/welcome?mode=reset" : "/welcome");
}
