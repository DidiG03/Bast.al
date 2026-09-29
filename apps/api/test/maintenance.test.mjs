// Pure pieces of the ledger and clean-up work: wording and limits.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma } from "@prisma/client";
import { ledgerReason } from "../dist/bets/settlement.service.js";
import { retentionDays } from "../dist/maintenance/retention.service.js";

const d = (v) => new Prisma.Decimal(v);

test("ledger entries say what happened to the bet", () => {
  assert.equal(ledgerReason("OPEN", "WON", d("20"), "Spain v Croatia · Match winner: Spain", null), "Bet won: Spain v Croatia · Match winner: Spain");
  assert.equal(ledgerReason("OPEN", "VOID", d("5"), "A v B · Correct score: 2–0", "Match abandoned"), "Bet refunded: A v B · Correct score: 2–0 (Match abandoned)");
  assert.equal(ledgerReason("WON", "LOST", d("-20"), "A v B", null), "Bet corrected, payout taken back: A v B");
  assert.equal(ledgerReason("LOST", "WON", d("20"), "A v B", null), "Bet corrected: A v B");
  assert.equal(ledgerReason("WON", "OPEN", d("-35"), null, null), "Bet corrected, payout taken back: bet");
});

test("clean-up keeps data at least as long as the minimums, whatever the settings", () => {
  const defaults = retentionDays({});
  assert.deepEqual(defaults, { oddsHistory: 30, unusedEvents: 30, readNotifications: 90, notifications: 180, loginHistory: 180, idempotencyKeys: 2 });
  const tooShort = retentionDays({ RETENTION_ODDS_HISTORY_DAYS: "1", RETENTION_UNUSED_EVENT_DAYS: "0", RETENTION_LOGIN_HISTORY_DAYS: "3" });
  assert.equal(tooShort.oddsHistory, 7);
  assert.equal(tooShort.unusedEvents, 30, "0 or junk falls back to the default");
  assert.equal(tooShort.loginHistory, 30);
  assert.equal(retentionDays({ RETENTION_ODDS_HISTORY_DAYS: "60" }).oddsHistory, 60);
});
