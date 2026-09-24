"use client";

// Chyba stránky firmy: menu i lišta s timerem (layout nad touhle hranicí)
// zůstanou, nahradí se jen obsah. Bez hranice spadla celá aplikace na
// „Application error".
import ErrorFallback from "@/components/ErrorFallback";

export default function WorkspaceError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return <ErrorFallback error={error} retry={unstable_retry} />;
}
