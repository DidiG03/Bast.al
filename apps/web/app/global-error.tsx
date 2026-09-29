"use client";

import { useEffect } from "react";
import { reportError } from "../lib/sentry";
import { LANG_COOKIE, parseLang, translate } from "../lib/i18n/core";

/**
 * The last resort: the root layout itself crashed, so none of the app's
 * styles or providers are there. Kept to plain HTML with inline styles.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => reportError(error), [error]);
  // No providers here, so the language comes straight from the cookie.
  const lang = parseLang(typeof document === "undefined" ? null : new RegExp(`${LANG_COOKIE}=(\\w+)`).exec(document.cookie)?.[1]);
  const t = (text: string, vars?: Record<string, string>) => translate(lang, text, vars);

  return (
    <html lang={lang}>
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", padding: 16, background: "#0b0b0c", color: "#ededef", fontFamily: "system-ui, sans-serif" }}>
        <main role="alert" style={{ maxWidth: 420, display: "grid", gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 22 }}>{t("Bast.al couldn't load")}</h1>
          <p style={{ margin: 0, color: "#a1a1aa", lineHeight: 1.5 }}>
            {t("Something went wrong on our side. Balances and bets are safe. Try again in a moment.")}
          </p>
          {error.digest ? <p style={{ margin: 0, color: "#71717a", fontSize: 13 }}>{t("Reference: {code}", { code: error.digest })}</p> : null}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={reset} style={{ padding: "10px 16px", borderRadius: 8, border: 0, background: "#ededef", color: "#18181b", font: "inherit", fontWeight: 600, cursor: "pointer" }}>
              {t("Try again")}
            </button>
            {/* A full page load on purpose: the app's own navigation isn't running. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/dashboard" style={{ padding: "10px 16px", borderRadius: 8, border: "1px solid #34343a", color: "#ededef", textDecoration: "none" }}>
              {t("Go to overview")}
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
