"use client";

import { useState, type ReactNode } from "react";
import type { OddsSelection } from "../lib/api";
import { useI18n } from "./i18n-provider";
import { MarketPriceHistory } from "./price-history";

export type LinedMarket = {
  id: string;
  key: string;
  name: string;
  suspended?: boolean;
  selections: OddsSelection[];
};

const LINE_KEY = /^(.+)_(\d+)_5$/;

function linePrefix(key: string): string | null {
  return LINE_KEY.exec(key)?.[1] ?? null;
}

function lineValue(key: string): number | null {
  const match = LINE_KEY.exec(key);
  return match ? Number(`${match[2]}.5`) : null;
}

function isOverUnder(market: LinedMarket): boolean {
  return market.selections.length === 2 && market.selections.every((selection) => selection.key === "over" || selection.key === "under");
}

/** Over/under lines of one market (2.5, 1.5, 3.5…) become one block with a line to change. */
export function bundleLines<T extends LinedMarket>(markets: T[]): Array<T | { kind: "lines"; lines: T[] }> {
  const used = new Set<string>();
  const bundled: Array<T | { kind: "lines"; lines: T[] }> = [];
  for (const market of markets) {
    if (used.has(market.id)) continue;
    const prefix = linePrefix(market.key);
    if (!prefix || !isOverUnder(market)) {
      bundled.push(market);
      continue;
    }
    const lines = markets.filter((item) => linePrefix(item.key) === prefix && isOverUnder(item));
    if (lines.length < 2) {
      bundled.push(market);
      continue;
    }
    for (const line of lines) used.add(line.id);
    bundled.push({ kind: "lines", lines });
  }
  return bundled;
}

/** The 1 X 2 heading over a match row, when the main market is the result. */
export function resultHeads(selections: Array<{ key: string }> | undefined): string[] {
  if (!selections || selections.length !== 3) return [];
  if (selections[0]?.key === "home" && selections[1]?.key === "draw" && selections[2]?.key === "away") return ["1", "X", "2"];
  return [];
}

/** Country name on a league, hidden when the flag already says it, or when the feed says "World". */
export function visibleCountry(country: string | null, flag: string | null): string | null {
  if (!country || flag) return null;
  return country.trim().toLowerCase() === "world" ? null : country;
}

/** One over/under market: the line steps, the two prices follow it. */
export function LineFamily<T extends LinedMarket>({ lines, children }: { lines: T[]; children: (market: T) => ReactNode }) {
  const { t, ts } = useI18n();
  const ordered = [...lines].sort((a, b) => (lineValue(a.key) ?? 0) - (lineValue(b.key) ?? 0));
  const preferred = ordered.findIndex((market) => lineValue(market.key) === 2.5);
  const [index, setIndex] = useState(preferred >= 0 ? preferred : Math.floor((ordered.length - 1) / 2));
  const safe = Math.min(index, ordered.length - 1);
  const market = ordered[safe];
  const line = lineValue(market.key);
  const title = ts(market.name).replace(/\s*\d+(?:\.\d+)?\s*$/, "").trim();
  return (
    <div className="odds-market">
      <div className="odds-market-head">
        <span className="odds-market-name">
          {title}
          {market.suspended ? <span className="muted"> · {t("Suspended")}</span> : null}
        </span>
        <span className="line-stepper">
          <button type="button" disabled={safe === 0} onClick={() => setIndex(safe - 1)} aria-label={t("Lower line")}>
            ‹
          </button>
          <span>{line === null ? "" : line.toFixed(1)}</span>
          <button type="button" disabled={safe === ordered.length - 1} onClick={() => setIndex(safe + 1)} aria-label={t("Higher line")}>
            ›
          </button>
        </span>
        <MarketPriceHistory selections={market.selections} compact />
      </div>
      {children(market)}
    </div>
  );
}
