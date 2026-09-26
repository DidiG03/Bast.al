"use client";

import { useState, type ReactNode } from "react";

type ReportsTabsProps = {
  overview: ReactNode;
  auditLog: ReactNode;
};

export function ReportsTabs({ overview, auditLog }: ReportsTabsProps) {
  const [activeTab, setActiveTab] = useState<"overview" | "audit">("overview");

  return (
    <div className="stack">
      <nav className="tabs-nav" aria-label="Reports tabs">
        <button
          type="button"
          className={`tab-button ${activeTab === "overview" ? "is-active" : ""}`}
          onClick={() => setActiveTab("overview")}
          aria-current={activeTab === "overview" ? "page" : undefined}
        >
          Overview
        </button>
        <button
          type="button"
          className={`tab-button ${activeTab === "audit" ? "is-active" : ""}`}
          onClick={() => setActiveTab("audit")}
          aria-current={activeTab === "audit" ? "page" : undefined}
        >
          Audit Log
        </button>
      </nav>

      <div className="tab-content">
        {activeTab === "overview" ? overview : auditLog}
      </div>
    </div>
  );
}
