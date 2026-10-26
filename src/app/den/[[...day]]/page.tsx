import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/session";
import { dayFromSlug, loadDayFirms, pragueToday } from "@/lib/dayList";
import DayListView from "@/components/DayListView";
import type { Membership } from "@/lib/types";

// /den = dnešek (stálá adresa pro záložku), /den/26-10-26 = konkrétní den.
// Jeden list na člověka: položky všech propojených účtů (účet na firmu),
// každá s vlaječkou firmy. Odemyká ho flag can_daylist (stačí v jedné firmě).
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
  const [membersRes, firmsRes] = await Promise.all([
    supabase
      .from("workspace_members")
      .select("workspace_id, role, can_daylist, time_only, percent_report")
      .eq("user_id", user.id),
    loadDayFirms(supabase),
  ]);
  // migrace 0053/0054 ještě neběží — funkce zatím neexistuje
  if (membersRes.error?.code === "42703" || firmsRes.missing) redirect("/");
  if (membersRes.error)
    throw new Error(`Členství se nepodařilo načíst: ${membersRes.error.message}`);
  if (firmsRes.error)
    throw new Error(`Firmy denního listu se nepodařilo načíst: ${firmsRes.error}`);

  const memberships = (membersRes.data ?? []) as Membership[];
  if (!memberships.some((m) => m.can_daylist)) redirect("/");

  // firmy přihlášeného účtu: karty v nich jde otevřít; zakládat jen tam,
  // kde smím zakládat úkoly („jen měření času" ne; adminům se flag ignoruje)
  const mineIds = memberships.map((m) => m.workspace_id);
  const creatableIds = memberships
    .filter((m) => m.role === "admin" || !(m.time_only || m.percent_report))
    .map((m) => m.workspace_id);

  return (
    <DayListView
      key={day}
      day={day}
      today={today}
      firms={firmsRes.firms}
      mineIds={mineIds}
      creatableIds={creatableIds}
    />
  );
}
