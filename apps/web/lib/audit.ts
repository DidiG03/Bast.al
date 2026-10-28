import type { I18n } from "../components/i18n-provider";
import type { AuditEntry } from "./api";
import { formatMoney } from "./format";
import { msg } from "./i18n/core";

/** Each audit action in plain words. Anything not listed shows its code with the dots and underscores as spaces. */
const ACTIONS: Record<string, string> = {
  "bet.place": msg("Bet placed"),
  "bet.void": msg("Bet voided by hand"),
  "bet.void_late": msg("Live bet voided: placed after a goal or card"),
  "bet.reinstate_late": msg("Live bet put back"),
  "bet.void_event": msg("Match voided"),
  "bet.void_unplayed": msg("Bets refunded: match not played"),
  "bet.selection_result": msg("Pick settled by hand"),
  "bet.result_correct": msg("Result corrected"),
  "bet.result_feed_correct": msg("Result corrected by the feed"),
  "bet.recheck_late": msg("Live bets checked again"),
  create: msg("Account created"),
  "user.create": msg("Account created"),
  "user.create.failure": msg("Account not created"),
  "user.update": msg("Account changed"),
  "user.delete": msg("Account deleted"),
  suspend: msg("Account blocked"),
  "user.suspend": msg("Account blocked"),
  unsuspend: msg("Account unblocked"),
  "user.unsuspend": msg("Account unblocked"),
  "user.suspend_from_clerk_delete": msg("Account blocked: its sign-in was deleted"),
  "user.reassign": msg("Player moved"),
  "user.delegate_credit": msg("Credit given"),
  "user.delegation_pending": msg("Credit waiting for approval"),
  "user.balance_approved": msg("Transfer approved"),
  "user.balance_rejected": msg("Transfer rejected"),
  "user.reclaim_credit": msg("Credit taken back"),
  "user.balance_adjustment": msg("Balance corrected"),
  "user.balance_limit_update": msg("Balance limit changed"),
  "user.approval_limit_update": msg("Approval limit changed"),
  "user.manager_capacity_update": msg("Manager's Player limit changed"),
  "user.commission_rate_update": msg("Commission rate changed"),
  "user.team_settings_update": msg("Team rules changed"),
  "user.identity_sync": msg("Sign-in details updated"),
  "user.bootstrap_super_admin": msg("Super Admin set up"),
  "user.bulk_suspend": msg("Accounts blocked together"),
  "user.bulk_unsuspend": msg("Accounts unblocked together"),
  "user.bulk_delegate": msg("Credit given to several accounts"),
  "user.bulk_reassign": msg("Players moved together"),
  "balance.topup_request": msg("Top-up asked for"),
  "casino.big_win": msg("Big casino win"),
  "casino.open_site": msg("Casino opened for the site"),
  "casino.close_site": msg("Casino closed for the site"),
  "casino.open_team": msg("Casino opened for a team"),
  "casino.close_team": msg("Casino closed for a team"),
  "casino.game_on_site": msg("Casino game turned on for the site"),
  "casino.game_off_site": msg("Casino game turned off for the site"),
  "casino.game_on_team": msg("Casino game turned on for a team"),
  "casino.game_off_team": msg("Casino game turned off for a team"),
  "odds.base_margin_update": msg("Base margin changed"),
  "odds.team_margin_update": msg("Team margin changed"),
  "odds.override_set": msg("Own price set"),
  "odds.override_clear": msg("Own price removed"),
  "odds.leagues_update": msg("Leagues changed"),
  "odds.event_update": msg("Match hidden or suspended"),
  "odds.sync": msg("Odds synced by hand"),
  "risk.cap_update": msg("Payout cap changed"),
  "data.reset": msg("All test data deleted"),
  "auth.failure": msg("Sign-in refused"),
  "auth.refused": msg("Sign-in refused"),
  "auth.session_revoke": msg("Device signed out"),
  "auth.sessions_revoke_other": msg("Other devices signed out"),
  "authz.failure": msg("Refused: not allowed"),
  "security.integrity_failure": msg("Request refused by the security check"),
};

type Translate = Pick<I18n, "t" | "tn" | "ts">;

export function auditLabel(action: string, { t }: Pick<Translate, "t">): string {
  const known = ACTIONS[action];
  return known ? t(known) : action.replaceAll(".", " ").replaceAll("_", " ");
}

/**
 * Who did it and to whom: one name when someone acted on their own account
 * (a Player's bet), "System" for what the site did by itself.
 */
export function auditParties(entry: { actor: { username: string } | null; target: { username: string } | null }, { t }: Pick<Translate, "t">): string {
  const actor = entry.actor?.username ?? t("System");
  if (!entry.target || entry.target.username === entry.actor?.username) return actor;
  return `${actor} → ${entry.target.username}`;
}

/** The useful part of what was recorded with it: the amount, the match, the change, the reason. */
export function auditDetails(entry: AuditEntry, { t, tn, ts }: Translate): string {
  const meta = (entry.metadata ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null);
  if (entry.action === "bet.place" && Array.isArray(meta.bets)) {
    parts.push(tn(meta.bets.length, "{count} bet", "{count} bets"));
    const total = number(meta.total);
    if (total !== null) parts.push(t("{amount} staked", { amount: formatMoney(total) }));
  } else {
    const amount = number(meta.amount) ?? number(meta.total);
    if (amount !== null) parts.push(formatMoney(amount));
  }
  if (typeof meta.event === "string") parts.push(meta.event);
  if (typeof meta.game === "string") parts.push(meta.game === "slot" ? "Sizzling Hot" : meta.game === "book" ? "Book of Ra" : meta.game);
  if (meta.from !== undefined && meta.to !== undefined && typeof meta.from !== "object") parts.push(`${String(meta.from)} → ${String(meta.to)}`);
  if (number(meta.rate) !== null) parts.push(`${number(meta.rate)}%`);
  if (typeof meta.count === "number") parts.push(tn(meta.count, "{count} account", "{count} accounts"));
  if (entry.action === "bet.recheck_late") {
    parts.push(t("{checked} checked, {voided} voided, {reinstated} put back", { checked: number(meta.checked) ?? 0, voided: number(meta.voided) ?? 0, reinstated: number(meta.reinstated) ?? 0 }));
  }
  const reason = typeof meta.reason === "string" ? meta.reason : typeof meta.previousReason === "string" ? meta.previousReason : null;
  if (reason) parts.push(ts(reason));
  return parts.join(" · ");
}
