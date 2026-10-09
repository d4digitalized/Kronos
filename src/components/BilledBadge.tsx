import type { TimeEntryBilling } from "@/lib/types";

/**
 * Štítek „Vyúčtováno 2603" u časového záznamu, který je ve vyúčtování
 * v TEKTOSu (0052). Data vrací RLS jen adminům firmy — ostatním se nic
 * nevykreslí. Odkaz vede na vyúčtování v TEKTOSu.
 */
export default function BilledBadge({
  billing,
  className = "",
}: {
  billing: TimeEntryBilling | TimeEntryBilling[] | null | undefined;
  className?: string;
}) {
  const b = Array.isArray(billing) ? billing[0] : billing;
  if (!b) return null;
  const paid = b.billing_status === "paid";
  const label = `Vyúčtováno ${b.billing_number}${paid ? " · uhrazeno" : ""}`;
  const cls = `${className} w-fit shrink-0 items-center rounded-full px-1.5 py-px text-[10px] font-medium ${
    paid ? "bg-emerald-100 text-emerald-800" : "bg-sky-100 text-sky-800"
  }`;
  return b.billing_url ? (
    <a
      href={b.billing_url}
      target="_blank"
      rel="noreferrer"
      title="Otevřít vyúčtování v TEKTOSu"
      className={`${cls} inline-flex hover:underline`}
    >
      {label}
    </a>
  ) : (
    <span className={`${cls} inline-flex`}>{label}</span>
  );
}
