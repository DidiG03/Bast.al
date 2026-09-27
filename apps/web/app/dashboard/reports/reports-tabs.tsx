"use client";

import { useState, type ReactNode } from "react";

type ReportsTabsProps = {
  overview: ReactNode;
  auditLog: ReactNode;
  commission: ReactNode;
};

export function ReportsTabs({ overview, auditLog, commission }: ReportsTabsProps) {
  const [activeTab, setActiveTab] = useState<"overview" | "audit" | "commission">("overview");

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
        <button
          type="button"
          className={`tab-button ${activeTab === "commission" ? "is-active" : ""}`}
          onClick={() => setActiveTab("commission")}
          aria-current={activeTab === "commission" ? "page" : undefined}
        >
          Commission
        </button>
      </nav>

      <div className="tab-content">
        {activeTab === "overview" ? overview : activeTab === "audit" ? auditLog : commission}
      </div>
    </div>
  );
}
