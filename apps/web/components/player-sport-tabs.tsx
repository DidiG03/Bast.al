"use client";

import { useState, type ReactNode } from "react";
import type { Sport } from "../lib/api";
import { SportIcon } from "./sport-icon";

export type SportTab = {
  key: Sport | "all";
  label: string;
  /** Matches playing now, shown as a count on the chip. */
  live: number;
  panel: ReactNode;
};

/** The home page's Top events: one chip per sport with matches (and "All"), each showing its own matches. */
export function PlayerSportTabs({ tabs, label }: { tabs: SportTab[]; label: string }) {
  const [active, setActive] = useState(tabs[0]?.key);
  return (
    <>
      <div className="sport-switch player-sport-switch" role="tablist" aria-label={label}>
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={tab.key === active}
            className={`sport-option${tab.key === active ? " is-active" : ""}`}
            onClick={(event) => {
              setActive(tab.key);
              // On a narrow screen the row scrolls: bring the chosen sport fully into view.
              event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
            }}
          >
            {tab.key === "all" ? <AllIcon /> : <SportIcon sport={tab.key} />}
            {tab.label}
            {tab.live > 0 ? <span className="sport-option-live">{tab.live}</span> : null}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div key={tab.key} role="tabpanel" hidden={tab.key !== active}>
          {tab.panel}
        </div>
      ))}
    </>
  );
}

/** Four squares: every sport at once. */
function AllIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </svg>
  );
}
