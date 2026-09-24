"use client";

// Chyba v kořenovém layoutu — nahrazuje ho celý, proto vlastní <html>/<body>.
import "./globals.css";
import ErrorFallback from "@/components/ErrorFallback";

export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <html lang="cs">
      <body className="flex min-h-screen items-start justify-center bg-paper p-4">
        <title>Kronos.</title>
        <ErrorFallback error={error} retry={unstable_retry} />
      </body>
    </html>
  );
}
