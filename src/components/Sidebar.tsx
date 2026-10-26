"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { cacheClear } from "@/lib/viewCache";
import Avatar from "@/components/Avatar";
import InboxCount from "@/components/InboxCount";
import {
  ICONS,
  NavIcon,
  buildNavSections,
  isNavActive,
} from "@/components/nav-shared";
import type { Profile, Workspace } from "@/lib/types";

const COLLAPSED_KEY = "kronos:sidebar-collapsed";

export default function Sidebar({
  wsId,
  workspaces,
  isAdmin,
  isSuperAdmin,
  canDelegate = false,
  canTaskforce = false,
  canNotes = false,
  canDaylist = false,
  timeOnly = false,
  userId,
  userName,
  userProfile,
  googleLinked = false,
}: {
  wsId: string;
  workspaces: Workspace[];
  isAdmin: boolean;
  isSuperAdmin: boolean;
  canDelegate?: boolean;
  canTaskforce?: boolean;
  canNotes?: boolean;
  canDaylist?: boolean;
  timeOnly?: boolean;
  userId?: string;
  userName: string;
  userProfile?: Profile | null;
  /** účet přilinkovaný ke Google (Workspace) — jméno svítí akcentem */
  googleLinked?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(localStorage.getItem(COLLAPSED_KEY) === "1");
  }, []);

  function toggleCollapsed() {
    setCollapsed((c) => {
      localStorage.setItem(COLLAPSED_KEY, c ? "0" : "1");
      return !c;
    });
  }

  async function logout() {
    const supabase = createClient();
    // jen toto zařízení — výchozí „global" odhlásí i telefon a ostatní prohlížeče
    await supabase.auth.signOut({ scope: "local" });
    cacheClear(); // ať se data neukážou dalšímu přihlášenému v téže záložce
    router.push("/login");
    router.refresh();
  }

  const sections = buildNavSections(
    wsId,
    isAdmin,
    isSuperAdmin,
    canDelegate,
    canTaskforce,
    canNotes,
    timeOnly,
    canDaylist
  );
  const isActive = (href: string) => isNavActive(pathname, href, wsId);

  return (
    <aside
      className={`sticky top-0 hidden h-screen shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-150 md:flex ${
        collapsed ? "w-14" : "w-60"
      }`}
    >
      <div className="flex items-center gap-2 p-3">
        {!collapsed && (
          <span className="font-display text-lg font-bold tracking-tight">
            Kronos<span className="text-accent">.</span>
          </span>
        )}
        <button
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Rozbalit menu" : "Sbalit menu"}
          className="ml-auto rounded-md p-1.5 text-ink-soft hover:bg-black/5"
        >
          <NavIcon d={collapsed ? ICONS.expand : ICONS.collapse} />
        </button>
      </div>

      {!collapsed &&
        (workspaces.length > 1 ? (
          <select
            value={wsId}
            onChange={(e) => router.push(`/w/${e.target.value}/my`)}
            aria-label="Přepnout workspace"
            className="input mx-3 mb-2 px-2 py-1"
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        ) : (
          <p className="mx-3 mb-2 truncate text-sm text-ink-soft">
            {workspaces[0]?.name}
          </p>
        ))}

      <nav className="flex-1 overflow-y-auto px-2 py-1">
        {sections.map((section) => (
          <div key={section.title} className="mb-4">
            {!collapsed && (
              <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-soft/70">
                {section.title}
              </p>
            )}
            {section.items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                title={collapsed ? item.label : undefined}
                className={`mb-0.5 flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm ${
                  isActive(item.href)
                    ? "bg-accent-soft font-medium text-accent"
                    : "text-ink-soft hover:bg-black/5"
                } ${collapsed ? "justify-center" : ""}`}
              >
                <NavIcon d={ICONS[item.icon]} />
                {!collapsed && <span className="truncate">{item.label}</span>}
                {!collapsed && item.badge && userId && (
                  <InboxCount wsId={wsId} userId={userId} />
                )}
              </Link>
            ))}
          </div>
        ))}
      </nav>

      <div
        className={`flex items-center gap-2 border-t border-line p-3 ${
          collapsed ? "flex-col" : ""
        }`}
      >
        <Avatar
          profile={userProfile ?? { full_name: userName }}
          colorKey={userProfile?.id ?? userName ?? "?"}
          size="md"
        />
        {!collapsed && (
          <span
            title={googleLinked ? "Účet propojen s Googlem" : undefined}
            className={`min-w-0 flex-1 truncate text-sm ${
              googleLinked ? "font-medium text-accent" : "text-ink-soft"
            }`}
          >
            {userName}
          </span>
        )}
        <Link
          href={`/w/${wsId}/settings`}
          title="Nastavení"
          aria-label="Nastavení"
          className="rounded-md p-1.5 text-ink-soft hover:bg-black/5"
        >
          <NavIcon d={ICONS.gear} />
        </Link>
        <button
          onClick={logout}
          title="Odhlásit"
          aria-label="Odhlásit"
          className="rounded-md p-1.5 text-ink-soft hover:bg-black/5"
        >
          <NavIcon d={ICONS.logout} />
        </button>
      </div>
    </aside>
  );
}
