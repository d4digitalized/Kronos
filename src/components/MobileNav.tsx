"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { cacheClear } from "@/lib/viewCache";
import InboxCount from "@/components/InboxCount";
import Avatar from "@/components/Avatar";
import {
  ICONS,
  NavIcon,
  buildNavSections,
  primaryNavItems,
  isNavActive,
} from "@/components/nav-shared";
import type { Profile, Workspace } from "@/lib/types";

// Mobilní navigace: trvalý spodní tab-bar (4 hlavní cíle) + „Menu", které
// otevře postranní drawer se zbytkem (workspace, přehledy, správa, účet).
// Zobrazuje se jen pod `md`; nad ním přebírá roli desktopový Sidebar.
export default function MobileNav({
  wsId,
  workspaces,
  isAdmin,
  isSuperAdmin,
  canDelegate = false,
  canTaskforce = false,
  canNotes = false,
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
  timeOnly?: boolean;
  userId?: string;
  userName: string;
  userProfile?: Profile | null;
  /** účet přilinkovaný ke Google (Workspace) — jméno svítí akcentem */
  googleLinked?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false); // drawer v DOM
  const [shown, setShown] = useState(false); // stav pro animaci

  const primary = primaryNavItems(wsId, canDelegate, canTaskforce, timeOnly);
  const sections = buildNavSections(
    wsId,
    isAdmin,
    isSuperAdmin,
    canDelegate,
    canTaskforce,
    canNotes,
    timeOnly
  );
  const isActive = (href: string) => isNavActive(pathname, href, wsId);

  function openDrawer() {
    setMounted(true);
    // dvojitý rAF: nech element vykreslit v „zavřeném" stavu, pak animuj dovnitř
    requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
  }
  function closeDrawer() {
    setShown(false);
    window.setTimeout(() => setMounted(false), 200);
  }

  // změna routy = zavřít drawer (bez animace, jsme už pryč)
  useEffect(() => {
    setShown(false);
    setMounted(false);
  }, [pathname]);

  // zamkni scroll pozadí + Esc, dokud je drawer otevřený
  useEffect(() => {
    if (!mounted) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [mounted]);

  async function logout() {
    const supabase = createClient();
    // jen toto zařízení — výchozí „global" odhlásí i počítač a ostatní prohlížeče
    await supabase.auth.signOut({ scope: "local" });
    cacheClear(); // ať se data neukážou dalšímu přihlášenému v téže záložce
    router.push("/login");
    router.refresh();
  }

  return (
    <>
      {/* Spodní tab-bar */}
      <nav
        className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur md:hidden"
        aria-label="Hlavní navigace"
      >
        <div className="flex items-stretch">
          {primary.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${
                  active ? "text-accent" : "text-ink-soft"
                }`}
              >
                <span className="relative">
                  <NavIcon d={ICONS[item.icon]} className="h-6 w-6 shrink-0" />
                  {item.badge && userId && (
                    <span className="absolute -right-3 -top-1.5">
                      <InboxCount wsId={wsId} userId={userId} />
                    </span>
                  )}
                </span>
                <span className="max-w-full truncate">{item.label}</span>
              </Link>
            );
          })}
          <button
            onClick={openDrawer}
            aria-label="Otevřít menu"
            className="flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] text-ink-soft"
          >
            <NavIcon d={ICONS.menu} className="h-6 w-6 shrink-0" />
            <span>Menu</span>
          </button>
        </div>
      </nav>

      {/* Drawer */}
      {mounted && (
        <div
          className="fixed inset-0 z-50 md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
        >
          <div
            className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${
              shown ? "opacity-100" : "opacity-0"
            }`}
            onClick={closeDrawer}
          />
          <aside
            className={`pt-safe pb-safe absolute inset-y-0 left-0 flex w-72 max-w-[85%] flex-col bg-surface shadow-xl transition-transform duration-200 ${
              shown ? "translate-x-0" : "-translate-x-full"
            }`}
          >
            <div className="flex items-center gap-2 p-3">
              <span className="font-display text-lg font-bold tracking-tight">
                Kronos<span className="text-accent">.</span>
              </span>
              <button
                onClick={closeDrawer}
                aria-label="Zavřít menu"
                className="ml-auto rounded-md p-1.5 text-ink-soft hover:bg-black/5"
              >
                <NavIcon d={ICONS.close} />
              </button>
            </div>

            {workspaces.length > 1 ? (
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
            )}

            <nav className="flex-1 overflow-y-auto px-2 py-1">
              {sections.map((section) => (
                <div key={section.title} className="mb-4">
                  <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-soft/70">
                    {section.title}
                  </p>
                  {section.items.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`mb-0.5 flex items-center gap-2.5 rounded-md px-2 py-2.5 text-sm ${
                        isActive(item.href)
                          ? "bg-accent-soft font-medium text-accent"
                          : "text-ink-soft hover:bg-black/5"
                      }`}
                    >
                      <NavIcon d={ICONS[item.icon]} />
                      <span className="truncate">{item.label}</span>
                      {item.badge && userId && (
                        <InboxCount wsId={wsId} userId={userId} />
                      )}
                    </Link>
                  ))}
                </div>
              ))}
            </nav>

            <div className="flex items-center gap-2 border-t border-line p-3">
              <Avatar
                profile={userProfile ?? { full_name: userName }}
                colorKey={userProfile?.id ?? userName ?? "?"}
                size="md"
              />
              <span
                title={googleLinked ? "Účet propojen s Googlem" : undefined}
                className={`min-w-0 flex-1 truncate text-sm ${
                  googleLinked ? "font-medium text-accent" : "text-ink-soft"
                }`}
              >
                {userName}
              </span>
              <Link
                href={`/w/${wsId}/settings`}
                aria-label="Nastavení"
                className="rounded-md p-2 text-ink-soft hover:bg-black/5"
              >
                <NavIcon d={ICONS.gear} />
              </Link>
              <button
                onClick={logout}
                aria-label="Odhlásit"
                className="rounded-md p-2 text-ink-soft hover:bg-black/5"
              >
                <NavIcon d={ICONS.logout} />
              </button>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
