"use client";

import { useEffect, useState } from "react";
import { entrySeconds, fmtClock } from "@/lib/format";

/** Běžící čas h:mm:ss. Každou sekundu se překreslí jen tahle drobnost,
    ne celá lišta s pickery a zvonečkem. startedAt = null → stojí na accum. */
export default function ElapsedClock({
  startedAt,
  accumSeconds = 0,
}: {
  startedAt: string | null;
  /** sečtené dřívější úseky (focus mode po pauzách) */
  accumSeconds?: number;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return <>{fmtClock(accumSeconds + (startedAt ? entrySeconds(startedAt, null) : 0))}</>;
}
