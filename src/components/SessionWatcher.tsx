"use client";

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { cacheClear } from "@/lib/viewCache";

// Session zanikla (zrušená na serveru, odhlášení v jiné záložce). Dřív
// aplikace dál běžela „mrtvá" — v logu 40 minut odmítnutých dotazů, Start
// timeru nic neudělal, jen hláška „obnov stránku". Teď rovnou přihlášení
// a po něm zpátky na stejnou stránku.
const NO_REDIRECT = ["/login", "/auth", "/oauth"];

export default function SessionWatcher() {
  useEffect(() => {
    const { data } = createClient().auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_OUT") return;
      cacheClear(); // ať se data neukážou dalšímu přihlášenému v téže záložce
      const { pathname, search } = window.location;
      if (NO_REDIRECT.some((p) => pathname.startsWith(p))) return;
      window.location.assign(
        `/login?signedout=1&next=${encodeURIComponent(pathname + search)}`
      );
    });
    return () => data.subscription.unsubscribe();
  }, []);

  return null;
}
