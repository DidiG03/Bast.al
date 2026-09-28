"use client";

import { useAuth } from "@clerk/nextjs";
import { useState } from "react";
import { apiFetch, type PricePoint } from "../lib/api";
import { LoadingSpinner } from "./loading-spinner";

const dateFormat = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

type MarketSelection = { id: string; name: string };

/**
 * A toggle under a market that reveals a small price-movement chart per
 * selection. One toggle per market (not per price button) keeps the odds
 * grid from getting cluttered, and avoids nesting a button inside a button.
 */
export function MarketPriceHistory({ selections }: { selections: MarketSelection[] }) {
  const { getToken } = useAuth();
  const [open, setOpen] = useState(false);
  const [byId, setById] = useState<Record<string, PricePoint[] | "error"> | null>(null);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (byId !== null) return;
    const token = await getToken();
    if (!token) return;
    const entries = await Promise.all(
      selections.map(async (selection): Promise<[string, PricePoint[] | "error"]> => {
        try {
          return [selection.id, await apiFetch<PricePoint[]>(`/odds/selections/${selection.id}/history`, token)];
        } catch {
          return [selection.id, "error"];
        }
      }),
    );
    setById(Object.fromEntries(entries));
  }

  return (
    <div className="price-history">
      <button type="button" className="text-button price-history-trigger" onClick={toggle} aria-expanded={open}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 19V5M4 19h17" />
          <path d="m7 15 4-4 3 2 5-6" />
        </svg>
        {open ? "Hide price history" : "Price history"}
      </button>
      {open ? (
        byId === null ? (
          <LoadingSpinner label="Loading price history" size="small" />
        ) : (
          <div className="price-history-panel">
            {selections.map((selection) => {
              const points = byId[selection.id];
              return (
                <div className="price-history-row" key={selection.id}>
                  <span className="price-history-name">{selection.name}</span>
                  {points === "error" ? (
                    <span className="error-text">Could not load</span>
                  ) : !points || points.length < 2 ? (
                    <span className="muted">No movement recorded yet</span>
                  ) : (
                    <PriceHistorySpark points={points} />
                  )}
                </div>
              );
            })}
          </div>
        )
      ) : null}
    </div>
  );
}

function PriceHistorySpark({ points }: { points: PricePoint[] }) {
  const width = 140;
  const height = 32;
  const prices = points.map((point) => point.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const coords = points.map((point, index) => {
    const x = (index / (points.length - 1)) * width;
    const y = height - ((point.price - min) / range) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const first = points[0];
  const last = points[points.length - 1];
  const trend = last.price === first.price ? "flat" : last.price > first.price ? "up" : "down";

  return (
    <span className="price-history-spark">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        <polyline points={coords.join(" ")} fill="none" />
      </svg>
      <span className={`price-history-summary is-${trend}`}>
        {first.price.toFixed(2)} → {last.price.toFixed(2)}
      </span>
      <span className="muted price-history-range">
        since {dateFormat.format(new Date(first.recordedAt))}
      </span>
    </span>
  );
}
