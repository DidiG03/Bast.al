"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch, type AdminBet, type BetLeg } from "../lib/api";
import { formatMoney } from "../lib/format";
import { BetLegs } from "./bet-legs";
import { LoadingSpinner } from "./loading-spinner";
import { useToast } from "./toaster";
import { useI18n } from "./i18n-provider";
import { HelpTip } from "./help-tip";


/** A single shown the same way as an accumulator's pick: selection, market, match, live score or kick-off. */
function picksOf(bet: AdminBet): BetLeg[] {
  if (bet.kind === "ACCUMULATOR") return bet.legs;
  if (!bet.selection || !bet.event) return [];
  return [{ name: bet.selection.name, market: bet.selection.market, odds: bet.odds ?? 0, result: null, voidReason: null, event: bet.event }];
}

/** A Player's open bets, for their Owner, Manager or Super Admin, from the Users tree. */
export function PlayerOpenBetsModal({ player, onClose }: { player: { id: string; username: string }; onClose: () => void }) {
  const { getToken } = useAuth();
  const { t, tn, date } = useI18n();
  const [bets, setBets] = useState<AdminBet[] | null>(null);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const token = await getToken();
        if (!token) throw new Error(t("You're not signed in"));
        const list = await apiFetch<AdminBet[]>(`/bets/admin?status=OPEN&playerId=${encodeURIComponent(player.id)}`, token);
        if (!cancelled) setBets(list);
      } catch (err) {
        if (cancelled) return;
        toast.error(err instanceof Error ? err.message : t("Couldn't load the bets"));
        onClose();
      }
    })();
    return () => {
      cancelled = true;
    };
    // `t` only changes with the language, which reloads the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getToken, player.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const staked = (bets ?? []).reduce((sum, bet) => sum + bet.stake, 0);
  const toReturn = (bets ?? []).reduce((sum, bet) => sum + (bet.potentialPayout ?? 0), 0);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal modal-wide card" role="dialog" aria-modal="true" aria-labelledby="open-bets-title">
        <div className="modal-header">
          <h2 id="open-bets-title">{t("{name}'s open bets", { name: player.username })}<HelpTip text="This Player's bets on matches that are not finished yet, and what they would win if the bets win." /></h2>
          <button type="button" className="modal-close secondary" onClick={onClose} aria-label={t("Close")}>
            ×
          </button>
        </div>
        {bets === null ? (
          <div className="loading-state">
            <LoadingSpinner label="Loading open bets" />
          </div>
        ) : bets.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t("No open bets right now. They may have just settled.")}</p>
        ) : (
          <>
            <dl className="bet-card-numbers open-bets-summary">
              <div>
                <dt className="muted">{t("Open bets")}</dt>
                <dd>{bets.length}</dd>
              </div>
              <div>
                <dt className="muted">{t("Staked")}</dt>
                <dd>{formatMoney(staked)}</dd>
              </div>
              <div>
                <dt className="muted">{t("Pays if all win")}</dt>
                <dd>{formatMoney(toReturn)}</dd>
              </div>
            </dl>
            <ul className="bet-list">
              {bets.map((bet) => (
                <li key={bet.id} className="card bet-card is-open">
                  <div className="bet-card-top">
                    <div className="bet-card-name">
                      <strong>{bet.kind === "ACCUMULATOR" ? tn(bet.legs.length, "Accumulator · {count} pick", "Accumulator · {count} picks") : t("Single")}</strong>
                      <span className="muted">{t("Placed {when}", { when: date(bet.placedAt, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) })}</span>
                    </div>
                    <span className="status-pill bet-status-open">{t("Open")}</span>
                  </div>
                  <BetLegs legs={picksOf(bet)} />
                  <dl className="bet-card-numbers">
                    <div>
                      <dt className="muted">{t("Stake")}</dt>
                      <dd>{formatMoney(bet.stake)}</dd>
                    </div>
                    <div>
                      <dt className="muted">{t("Odds")}</dt>
                      <dd>{bet.odds?.toFixed(2) ?? "–"}</dd>
                    </div>
                    <div>
                      <dt className="muted">{t("To return")}</dt>
                      <dd>{formatMoney(bet.potentialPayout ?? 0)}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="modal-actions">
          <Link className="button-link" href={`/dashboard/players/${player.id}`}>
            {t("All activity")}
          </Link>
          <button type="button" onClick={onClose}>
            {t("Close")}
          </button>
        </div>
      </section>
    </div>
  );
}
