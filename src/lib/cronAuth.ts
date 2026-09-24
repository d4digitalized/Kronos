import { timingSafeEqual } from "crypto";

/** Autorizace cron / ručního vyvolání: hlavička `Bearer CRON_SECRET`.
    Bez nastaveného tajemství nepustí nikoho — dřív prošla i hlavička
    „Bearer undefined". Porovnání v konstantním čase. */
export function isCronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}
