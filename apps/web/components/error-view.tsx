"use client";

import Link from "next/link";
import { useEffect } from "react";
import { reportError } from "../lib/sentry";
import { useI18n } from "./i18n-provider";

/**
 * What a page shows when it crashes: a plain explanation, a way to try again
 * and a way out. The reference code matches the server's log entry for the
 * failure, so it's worth quoting when reporting a problem.
 */
export function ErrorView({ error, reset, home = "/dashboard" }: { error: Error & { digest?: string }; reset: () => void; home?: string }) {
  const { t } = useI18n();
  useEffect(() => reportError(error), [error]);

  return (
    <div className="error-view">
      <section className="card stack error-view-card" role="alert">
        <h1 style={{ margin: 0 }}>{t("Something went wrong")}</h1>
        <p className="muted" style={{ margin: 0 }}>
          {t("This page couldn't load. Balances and bets are safe: they only change on the server, all at once or not at all. Try again, and if it keeps happening, report it with the reference below.")}
        </p>
        {error.digest ? <p className="muted error-view-ref">{t("Reference: {code}", { code: error.digest })}</p> : null}
        <div className="row error-view-actions">
          <button type="button" onClick={reset}>
            {t("Try again")}
          </button>
          <Link className="button-link" href={home}>
            {t("Go to overview")}
          </Link>
        </div>
      </section>
    </div>
  );
}
