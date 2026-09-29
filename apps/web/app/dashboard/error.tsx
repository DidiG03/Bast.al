"use client";

import { ErrorView } from "../../components/error-view";

/** A dashboard page crashed: shown inside the dashboard, so the sidebar and top bar still work. */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorView error={error} reset={reset} />;
}
