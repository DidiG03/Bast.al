import Link from "next/link";
import { getT } from "../lib/i18n/server";

/** A link or typed address that goes nowhere. */
export default function NotFound() {
  const { t } = getT();
  return (
    <main className="error-page">
      <div className="error-view">
        <section className="card stack error-view-card">
          <h1 style={{ margin: 0 }}>{t("Page not found")}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {t("This page doesn't exist, or it has moved. Check the address, or head back to your overview.")}
          </p>
          <div className="row error-view-actions">
            <Link className="button-link" href="/dashboard">
              {t("Go to overview")}
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
