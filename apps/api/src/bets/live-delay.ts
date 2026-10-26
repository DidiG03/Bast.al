/**
 * How long a live bet waits before it is accepted.
 *
 * Delay = that competition's measured goal lag + margin, never under the
 * minimum and never over the maximum. A competition whose own lag is at
 * least the maximum is pre-match only: the wait cannot cover it.
 *
 * LIVE_LAG_MARGIN_MS, LIVE_BET_DELAY_MS and LIVE_BET_MAX_DELAY_MS override
 * the three numbers. Read on each bet, so a change applies without a rebuild.
 */

const envMs = (name: string, fallback: number) => {
  const raw = process.env[name];
  const value = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(value) && value >= 0 ? value : fallback;
};

export type LiveConfirmConfig = { marginMs: number; minMs: number; maxMs: number };

export function liveConfirmConfig(): LiveConfirmConfig {
  const minMs = envMs("LIVE_BET_DELAY_MS", 8_000);
  const maxMs = Math.max(minMs, envMs("LIVE_BET_MAX_DELAY_MS", 20_000));
  return { marginMs: envMs("LIVE_LAG_MARGIN_MS", 3_000), minMs, maxMs };
}

/** The wait for a measured lag (ms), or the minimum when the competition has not been measured yet. */
export function confirmationDelay(lagMs: number | null, config: LiveConfirmConfig = liveConfirmConfig()): number {
  const raw = lagMs === null ? config.minMs : lagMs + config.marginMs;
  return Math.min(config.maxMs, Math.max(config.minMs, raw));
}
