"use client";

import { ErrorView } from "../components/error-view";

/** Anything outside the dashboard crashed, or the dashboard's own layout did. */
export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="error-page">
      <ErrorView error={error} reset={reset} />
    </main>
  );
}
