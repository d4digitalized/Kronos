// Ruční/záložní vyvolání odeslání fronty (Bearer CRON_SECRET).
// Běžně e-maily odchází hned po akci přes /api/notify/run.

import { NextResponse } from "next/server";
import { drainNotifications } from "@/lib/notify-drain";
import { isCronAuthorized } from "@/lib/cronAuth";

export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return NextResponse.json(await drainNotifications());
}
