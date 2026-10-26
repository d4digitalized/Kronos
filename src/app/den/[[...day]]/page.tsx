import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/session";
import { dayFromSlug, pragueToday } from "@/lib/dayList";
import DayListView from "@/components/DayListView";
import type { Membership, Workspace } from "@/lib/types";

// /den = dnešek (stálá adresa pro záložku), /den/26-10-26 = konkrétní den.
// Jeden list na uživatele napříč firmami; odemyká ho flag can_daylist
// (stačí v jedné firmě).
export default async function DenPage({
  params,
}: {
  params: Promise<{ day?: string[] }>;
}) {
  const { day: parts } = await params;
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const today = pragueToday();
  let day = today;
  if (parts?.length) {
    const parsed = parts.length === 1 ? dayFromSlug(parts[0]) : null;
    if (!parsed) notFound();
    if (parsed === today) redirect("/den");
    day = parsed;
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("workspace_members")
    .select("role, can_daylist, time_only, percent_report, workspaces(id, name)")
    .eq("user_id", user.id);
  if (error) {
    // migrace 0053 ještě neběží — funkce zatím neexistuje
    if (error.code === "42703") redirect("/");
    throw new Error(`Členství se nepodařilo načíst: ${error.message}`);
  }
  const memberships = (data ?? []) as unknown as Membership[];
  if (!memberships.some((m) => m.can_daylist)) redirect("/");

  // kartu z položky jde založit jen ve firmě, kde smím zakládat úkoly
  // („jen měření času" ne; adminům se flag ignoruje)
  const firms: Workspace[] = memberships
    .filter(
      (m) => m.workspaces && (m.role === "admin" || !(m.time_only || m.percent_report))
    )
    .map((m) => m.workspaces as Workspace)
    .sort((a, b) => a.name.localeCompare(b.name, "cs"));

  return <DayListView key={day} userId={user.id} day={day} today={today} firms={firms} />;
}
