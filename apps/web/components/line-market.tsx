"use client";

import { useRef, useState, type ReactNode } from "react";
import type { OddsSelection } from "../lib/api";
import { useI18n } from "./i18n-provider";
import { MarketPriceHistory } from "./price-history";

export type LinedMarket = {
  id: string;
  key: string;
  name: string;
  suspended?: boolean;
  /** Live: paused after something in the match (a goal, a card…), back shortly. */
  paused?: string | null;
  /** Live: held by the bookmaker just after that pause ended, its new prices on the way. */
  after?: string | null;
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

/**
 * What a star on a market is saved as: its key, or "lines:<prefix>" for an
 * over/under market, so starring Total goals at 2.5 stars it at every line,
 * and on every match.
 */
export function marketKind(market: LinedMarket): string {
  const prefix = linePrefix(market.key);
  return prefix && isOverUnder(market) ? `lines:${prefix}` : market.key;
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

/**
 * A market's heading in an opened match. It opens and closes the market; the
 * line and price tools beside it only show while it's open. A closed market
 * with a pick on the slip shows a dot, so the pick isn't hidden.
 */
export function MarketHead({
  title,
  suspended,
  paused,
  after = false,
  open,
  onToggle,
  picked,
  starred,
  onStar,
  quiet = false,
  children,
}: {
  title: string;
  suspended?: boolean;
  /** Paused for a moment after a goal or a card, rather than off the board. */
  paused?: boolean;
  /** Held by the bookmaker just after such a pause: "New prices coming" rather than "Suspended". */
  after?: boolean;
  open: boolean;
  onToggle: () => void;
  picked: boolean;
  /** In this account's favourite markets; the star sits at the end of the heading, open or closed. */
  starred: boolean;
  onStar: () => void;
  /** Already inside "Not available during play": the row doesn't also say Suspended. */
  quiet?: boolean;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="odds-market-head">
      <button type="button" className="text-button odds-market-toggle" aria-expanded={open} onClick={onToggle}>
        <svg className="odds-market-chevron" viewBox="0 0 24 24" aria-hidden="true">
          <path d="m9 6 6 6-6 6" />
        </svg>
        <span className="odds-market-name">
          {title}
          {suspended && !quiet ? <span className="muted"> · {paused ? t("Paused") : after ? t("New prices coming") : t("Suspended")}</span> : null}
        </span>
        {picked && !open ? <span className="odds-market-picked" role="img" aria-label={t("On your slip")} title={t("On your slip")} /> : null}
      </button>
      {open ? children : null}
      <button
        type="button"
        className={`match-star odds-market-star${starred ? " is-starred" : ""}`}
        onClick={onStar}
        aria-pressed={starred}
        aria-label={starred ? t("Remove {market} from favourite markets", { market: title }) : t("Add {market} to favourite markets", { market: title })}
        title={starred ? t("Remove from favourite markets") : t("Add to favourite markets")}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />
        </svg>
      </button>
    </div>
  );
}

/** The bookmaker's most even open line, used once as the line the stepper starts on. */
function evenest(lines: LinedMarket[]): number | null {
  let best: { line: number; gap: number } | null = null;
  for (const market of lines) {
    const line = lineValue(market.key);
    const over = market.selections.find((selection) => selection.key === "over");
    const under = market.selections.find((selection) => selection.key === "under");
    if (line === null || !over || !under || over.suspended || under.suspended || over.price <= 1 || under.price <= 1) continue;
    const gap = Math.abs(over.price - under.price);
    if (!best || gap < best.gap) best = { line, gap };
  }
  return best?.line ?? null;
}

/**
 * One over/under market: the line steps, the two prices follow it. The step
 * stays on a line value the bookmaker is pricing. Adding or dropping other
 * lines does not move it. Open or closed like any other market (MarketHead).
 */
export function LineFamily<T extends LinedMarket>({
  lines,
  open,
  onToggle,
  picked,
  starred,
  onStar,
  quiet = false,
  children,
}: {
  lines: T[];
  open: boolean;
  onToggle: () => void;
  /** One of its lines has a pick on the slip. */
  picked: boolean;
  starred: boolean;
  onStar: () => void;
  quiet?: boolean;
  children: (market: T) => ReactNode;
}) {
  const { t, ts } = useI18n();
  const [, redraw] = useState(0);
  const chosen = useRef<number | null>(null);
  const ordered = [...lines].sort((a, b) => (lineValue(a.key) ?? 0) - (lineValue(b.key) ?? 0));
  const priced = ordered.filter((market) => !market.suspended);
  const pool = priced.length > 0 ? priced : ordered;
  if (chosen.current === null) chosen.current = evenest(priced.length > 0 ? priced : ordered) ?? lineValue(pool[0]?.key ?? "");
  const at = Math.max(0, pool.findIndex((market) => lineValue(market.key) === chosen.current));
  const market = pool[at] ?? pool[0];
  const line = market ? lineValue(market.key) : null;
  const title = market ? ts(market.name).replace(/\s*\d+(?:\.\d+)?\s*$/, "").trim() : "";
  const step = (next: number) => {
    const value = lineValue(pool[next]?.key ?? "");
    if (value === null) return;
    chosen.current = value;
    redraw((n) => n + 1);
  };
  if (!market) return null;
  return (
    <div className={`odds-market${open ? " is-open" : ""}`}>
      <MarketHead title={title} suspended={market.suspended} paused={Boolean(market.paused)} after={Boolean(market.after)} quiet={quiet} open={open} onToggle={onToggle} picked={picked} starred={starred} onStar={onStar}>
        <span className="line-stepper">
          <button type="button" disabled={at === 0} onClick={() => step(at - 1)} aria-label={t("Lower line")}>
            ‹
          </button>
          <span>{line === null ? "" : line.toFixed(1)}</span>
          <button type="button" disabled={at === pool.length - 1} onClick={() => step(at + 1)} aria-label={t("Higher line")}>
            ›
          </button>
        </span>
        <MarketPriceHistory selections={market.selections} compact />
      </MarketHead>
      {open ? children(market) : null}
    </div>
  );
}
