"use client";

// Chyba mimo stránky firmy nebo v layoutu firmy (lišta, menu, „+").
import ErrorFallback from "@/components/ErrorFallback";

export default function RootError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <main className="flex min-h-screen items-start justify-center bg-paper p-4">
      <ErrorFallback error={error} retry={unstable_retry} />
    </main>
  );
}
