"use client";

import { useState, type ReactNode } from "react";
import { useI18n } from "../../../components/i18n-provider";

type ReportsTabsProps = {
  overview: ReactNode;
  auditLog: ReactNode;
};

export function ReportsTabs({ overview, auditLog }: ReportsTabsProps) {
  const [activeTab, setActiveTab] = useState<"overview" | "audit">("overview");
  const { t } = useI18n();

  return (
    <div className="stack">
      <nav className="tabs-nav" aria-label={t("Reports tabs")}>
        <button
          type="button"
          className={`tab-button ${activeTab === "overview" ? "is-active" : ""}`}
          onClick={() => setActiveTab("overview")}
          aria-current={activeTab === "overview" ? "page" : undefined}
        >
          {t("Overview")}
        </button>
        <button
          type="button"
          className={`tab-button ${activeTab === "audit" ? "is-active" : ""}`}
          onClick={() => setActiveTab("audit")}
          aria-current={activeTab === "audit" ? "page" : undefined}
        >
          {t("Audit log")}
        </button>
      </nav>

      <div className="tab-content">
        {activeTab === "overview" ? overview : auditLog}
      </div>
    </div>
  );
}
