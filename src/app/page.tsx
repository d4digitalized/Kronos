import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/session";

export default async function Home() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const supabase = await createClient();

  const { data: memberships, error } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1);
  // chyba dotazu ≠ „nejsi členem" — ať se neukáže hláška jako po vyřazení
  if (error) throw new Error(`Členství se nepodařilo načíst: ${error.message}`);

  if (memberships && memberships.length > 0) {
    redirect(`/w/${memberships[0].workspace_id}/my`);
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("is_super_admin")
    .eq("id", user.id)
    .single();

  if (profile?.is_super_admin) redirect("/admin");

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <p className="text-ink-soft">
        Zatím nejsi členem žádného workspace. Požádej admina o pozvánku.
      </p>
    </main>
  );
}
