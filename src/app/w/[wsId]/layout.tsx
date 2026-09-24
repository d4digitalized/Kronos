import { notFound, redirect } from "next/navigation";
import { getWsContext } from "@/lib/session";
import Sidebar from "@/components/Sidebar";
import MobileNav from "@/components/MobileNav";
import TimerBar from "@/components/TimerBar";
import NewTaskFab from "@/components/NewTaskFab";
import ProjectColorsLoader from "@/components/ProjectColorsLoader";

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ wsId: string }>;
}) {
  const { wsId } = await params;
  // jeden sdílený dotaz na požadavek (React cache) — stránka pod layoutem
  // dostane tentýž výsledek, nic nedotahuje znovu
  const ctx = await getWsContext(wsId);
  if (!ctx) redirect("/login");
  if (!ctx.ws) notFound();

  const {
    user,
    profile,
    isAdmin,
    isSuperAdmin,
    canDelegate,
    canTaskforce,
    canNotes,
    percentReport,
    timeOnly,
    wsOptions,
    workspaces,
  } = ctx;
  const userName = profile?.full_name || profile?.email || "";

  return (
    <div className="flex min-h-screen bg-paper">
      <Sidebar
        wsId={wsId}
        workspaces={workspaces}
        isAdmin={isAdmin}
        isSuperAdmin={isSuperAdmin}
        canDelegate={canDelegate}
        canTaskforce={canTaskforce}
        canNotes={canNotes}
        timeOnly={timeOnly}
        userId={user.id}
        userName={userName}
        userProfile={profile}
        googleLinked={user.googleLinked}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* výkaz v %: timer schovat — záznamy generuje procentní výkaz */}
        <TimerBar
          wsId={wsId}
          userId={user.id}
          workspaces={workspaces}
          noTimer={percentReport}
        />
        {/* spodní padding drží obsah nad mobilním tab-barem (jen pod md) */}
        {/* flex-col: stránka (nástěnka) se může roztáhnout až ke spodní hraně */}
        <main className="flex flex-1 flex-col space-y-4 p-4 pb-24 md:pb-4">
          {children}
        </main>
      </div>
      <MobileNav
        wsId={wsId}
        workspaces={workspaces}
        isAdmin={isAdmin}
        isSuperAdmin={isSuperAdmin}
        canDelegate={canDelegate}
        canTaskforce={canTaskforce}
        canNotes={canNotes}
        timeOnly={timeOnly}
        userId={user.id}
        userName={userName}
        userProfile={profile}
        googleLinked={user.googleLinked}
      />
      {/* „jen měření času": žádné zakládání úkolů */}
      {!timeOnly && (
        <NewTaskFab wsId={wsId} userId={user.id} workspaces={wsOptions} />
      )}
      {/* tečky projektů dědí barvu své kategorie */}
      <ProjectColorsLoader wsId={wsId} />
    </div>
  );
}
