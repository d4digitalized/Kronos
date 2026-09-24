import type { Instrumentation } from "next";

// Chyby serveru (render, route handler, server action, proxy) do logu Vercelu
// jedním řádkem: hledat „kronos-request-error", spárovat přes digest s kódem,
// který uživatel vidí na chybové stránce. Dřív výpadky nezanechaly
// dohledatelnou stopu. Hlavičky záměrně ne — nesou cookies se session.
export const onRequestError: Instrumentation.onRequestError = (err, request, context) => {
  const e = err as Error & { digest?: string };
  console.error(
    JSON.stringify({
      tag: "kronos-request-error",
      digest: e.digest,
      message: e.message,
      path: request.path,
      method: request.method,
      routePath: context.routePath,
      routeType: context.routeType,
      renderSource: context.renderSource,
      stack: e.stack?.split("\n").slice(0, 8).join(" | "),
    })
  );
};
