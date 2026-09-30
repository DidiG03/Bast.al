import { currentBrowserLang, msg, translateServer } from "./i18n/core";

function apiBase(): string {
  // Browser → Next BFF (adds HMAC). Server components → Nest directly.
  if (typeof window !== "undefined") {
    return "/api/backend";
  }
  return `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"}/api`;
}

export type UserRole = "SUPER_ADMIN" | "OWNER" | "MANAGER" | "PLAYER";

export type MeResponse = {
  id: string;
  username: string;
  role: UserRole;
  parentId: string | null;
  parent: { id: string; username: string; role: UserRole } | null;
  status: "ACTIVE" | "SUSPENDED";
  balance: number | string;
  balanceLimit: number | string;
  managerCapacity: number;
  commissionRate: number;
  /** Largest delegation this account can make without approval. */
  approvalLimit: number;
  mfaRequired: boolean;
  mfaEnabled: boolean;
  mfaSatisfied: boolean;
};

export type UserRow = {
  id: string;
  username: string;
  role: MeResponse["role"];
  parentId: string | null;
  status: MeResponse["status"];
  balance: number | string;
  balanceLimit: number | string;
  managerCapacity: number;
  commissionRate: number;
  /** MANAGER only: personal approval limit; null means the platform default. */
  approvalLimit: number | string | null;
  createdAt: string;
};

export type ReassignmentPreview = {
  valid: boolean;
  reason: string | null;
  player: { id: string; username: string; currentManagerId: string | null };
  destination: { id: string; username: string; capacity: number; assigned: number; remaining: number };
  impact: { movedAccounts: number; currentManagerId: string | null };
};

export type CreateUserRequest = {
  username: string;
  password: string;
  role: "OWNER" | "MANAGER" | "PLAYER";
  parentId?: string;
};

export type BalanceEntry = {
  id: string;
  type: "DELEGATION" | "RECLAIM" | "ADJUSTMENT" | "BET_STAKE" | "BET_SETTLEMENT";
  status?: "PENDING" | "APPROVED" | "REJECTED";
  approvedAt?: string | null;
  /** Signed from the viewed account's perspective: received = positive, given away = negative. */
  amount: number;
  reason: string;
  createdAt: string;
  /** Who's on the other side of this entry — the counterparty, not necessarily who triggered it. */
  counterparty?: string;
  actor: { id?: string; username: string } | null;
};

export type TransactionDetails = BalanceEntry & {
  toUser: { id: string; username: string };
  fromUser: { id: string; username: string } | null;
  approvedBy: { id: string; username: string } | null;
};

export type BalanceStatement = {
  account: { username: string; balance: number | string };
  from: string | null;
  to: string | null;
  entries: BalanceEntry[];
};

export type SecurityOverview = {
  sessions: Array<{
    id: string;
    status: string;
    lastActiveAt: number;
    expireAt: number;
    abandonAt: number | null;
    /** From this session's sign-in history, when it has one. */
    device: string | null;
    browser: string | null;
    ipAddress: string | null;
    location: string | null;
  }>;
  activity: Array<{ id: string; action: string; ipAddress: string | null; metadata: unknown; createdAt: string }>;
  loginHistory: Array<{ id: string; sessionId: string; ipAddress: string | null; device: string | null; browser: string | null; location: string | null; lastSeenAt: string; createdAt: string }>;
};

export type NotificationItem = {
  id: string;
  type: "FUNDS_RECEIVED" | "FUNDS_RECLAIMED" | "APPROVAL_REQUESTED" | "COMMISSION_RATE_UPDATED" | "ACCOUNT_SUSPENDED" | "ACCOUNT_UPDATED" | "ACCOUNT_REASSIGNED" | "SUSPICIOUS_LOGIN" | "LOW_BALANCE" | "BET_SETTLED";
  category: "FINANCE" | "ACCOUNT" | "SECURITY" | "SYSTEM";
  severity: "INFO" | "SUCCESS" | "WARNING" | "CRITICAL";
  title: string;
  message: string;
  metadata: unknown;
  readAt: string | null;
  archivedAt: string | null;
  createdAt: string;
};

export type NotificationPreferences = {
  inAppEnabled: boolean;
  emailEnabled: boolean;
  financeEnabled: boolean;
  accountEnabled: boolean;
  securityEnabled: boolean;
  systemEnabled: boolean;
};

export type NotificationResponse = {
  items: NotificationItem[];
  unreadCount: number;
};

export type UserReport = {
  generatedAt: string;
  totals: {
    users: number;
    owners: number;
    managers: number;
    players: number;
    active: number;
    suspended: number;
    totalBalance: number;
  };

  roleBreakdown: { OWNER: number; MANAGER: number; PLAYER: number };
  statusBreakdown: { ACTIVE: number; SUSPENDED: number };
  /** OWNER for a Super Admin's report, MANAGER for an Owner's, PLAYER for a Manager's. */
  accountRole: "OWNER" | "MANAGER" | "PLAYER";
  accounts: Array<{ id: string; username: string; status: UserRow["status"]; balance: number; commissionRate: number; directReports: number }>;
  recentAudit: Array<{
    id: string;
    action: string;
    targetId: string | null;
    createdAt: string;
    actor: { username: string; role: UserRow["role"] } | null;
    target: { username: string; role: UserRow["role"] } | null;
  }>;
};

export type AuditEntry = {
  id: string;
  action: string;
  ipAddress: string | null;
  metadata: unknown;
  createdAt: string;
  actor: { id: string; username: string; role: MeResponse["role"] } | null;
  target: { id: string; username: string; role: MeResponse["role"] } | null;
};

export type AuditResponse = {
  items: AuditEntry[];
  total: number;
  page: number;
  limit: number;
  pages: number;
};

export type FinancialReport = {
  from: string | null;
  to: string | null;
  recipients: Array<{ userId: string; username: string; role: MeResponse["role"]; totalDelegated: number; totalReclaimed: number; net: number }>;
};

export type PendingApproval = {
  id: string;
  type: BalanceEntry["type"];
  amount: number;
  reason: string;
  status: "PENDING";
  createdAt: string;
  fromUser: { id: string; username: string } | null;
  toUser: { id: string; username: string; role: UserRole };
  actor: { id: string; username: string; role: UserRole } | null;
};

const TRANSACTION_LABELS: Record<BalanceEntry["type"], string> = {
  DELEGATION: msg("Delegation"),
  RECLAIM: msg("Reclaim"),
  ADJUSTMENT: msg("Adjustment"),
  BET_STAKE: msg("Bet placed"),
  BET_SETTLEMENT: msg("Bet settled"),
};

export function transactionLabel(type: BalanceEntry["type"]): string {
  return TRANSACTION_LABELS[type];
}

export type CommissionRateResponse = { rate: number };

/** Commission paid for a period: collected from an Owner, or paid to a Manager. */
export type CommissionPayout = {
  id: string;
  /** The Owner who paid Super Admin, or the Manager who was paid. */
  userId: string;
  periodFrom: string;
  periodTo: string;
  amount: number;
  createdAt: string;
  /** PENDING while an Owner's payment waits for approval; REJECTED payouts don't count. */
  status: "PENDING" | "APPROVED" | "REJECTED";
};

/** Settled-bet totals. `net` is the team's profit: what Players staked minus what they were paid. */
export type CommissionTotals = { bets: number; staked: number; paidOut: number; net: number };

export type PlayerResult = CommissionTotals & { id: string; username: string; status: UserRow["status"] };

type CommissionPeriod = { from: string; to: string };

export type OwnerSplit = CommissionTotals & {
  /** What the Owner pays Super Admin: their rate on the whole team's profit. */
  superAdminCut: number;
  /** What the Owner pays their Managers in total. */
  managerCommission: number;
  ownerKeeps: number;
};

export type SuperAdminCommissions = CommissionPeriod & {
  totals: OwnerSplit;
  owners: Array<OwnerSplit & { id: string; username: string; status: UserRow["status"]; commissionRate: number; managers: number; players: number }>;
};

export type TeamCommissions = CommissionPeriod & {
  owner: { id: string; username: string; commissionRate: number };
  totals: OwnerSplit;
  managers: Array<CommissionTotals & { id: string; username: string; status: UserRow["status"]; commissionRate: number; commission: number; players: PlayerResult[] }>;
  directPlayers: PlayerResult[];
};

export type CommissionHistory = {
  commissionRate: number;
  weeks: Array<CommissionTotals & { from: string; to: string; commission: number }>;
};

/** Day-by-day settled-bet totals (UTC), oldest first; today runs to now. */
export type CommissionDaily = { days: Array<CommissionTotals & { from: string; to: string }> };

type BetSummary = { id: string; description: string | null; odds: number | null; stake: number; placedAt: string };

export type PlayerActivity = {
  player: { id: string; username: string; status: UserRow["status"]; balance: number; parent: { username: string; role: UserRole } | null };
  summary: { thisWeek: CommissionTotals; last30Days: CommissionTotals; allTime: CommissionTotals };
  open: { count: number; staked: number; bets: BetSummary[] };
  recent: Array<BetSummary & { payout: number; status: "WON" | "LOST" | "VOID"; settledAt: string | null }>;
};

/** A Player's betting limits. null means no limit. */
export type Limits = { maxStake: number | null; dailyLossLimit: number | null };

export type BettingLimits = {
  /** The ceiling the Owner (or Super Admin) sets. */
  owner: Limits;
  /** What the Player's Manager tightened it to, if anything. */
  manager: Limits;
  /** What applies: the stricter of the two. */
  effective: Limits;
  lossToday: number;
  editable: "owner" | "manager" | null;
  hasManager: boolean;
};

export type TeamSettings = { lowBalanceThreshold: number | null; managerApprovalLimit: number | null; defaultApprovalLimit: number };

export type BulkAction = "suspend" | "unsuspend" | "delegate" | "reassign";
export type BulkResult = { results: Array<{ id: string; ok: boolean; error?: string; pending?: boolean }> };

/** The platform-wide delegation size above which a second person must approve. */
export const DEFAULT_APPROVAL_LIMIT = 10000;

export type ManagerCommissions = CommissionPeriod & {
  manager: { id: string; username: string; commissionRate: number };
  paidBy: string | null;
  totals: CommissionTotals & { commission: number };
  players: PlayerResult[];
};

/**
 * A one-time ID for an action that moves money. Create one per intended action
 * and send the same one on every retry of it, so the server runs it once.
 */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** An API error: `message` is in the reader's language, `original` is the API's English, for code that reacts to it. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly original: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function apiFetch<T>(
  path: string,
  token: string,
  init?: RequestInit & { idempotencyKey?: string },
): Promise<T> {
  const normalized = path.startsWith("/") ? path.slice(1) : path;
  const { idempotencyKey, ...rest } = init ?? {};
  const res = await fetch(`${apiBase()}/${normalized}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      ...(rest.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // Form checks come back as a list, one message per problem.
    const parts: string[] =
      typeof body?.message === "string"
        ? [body.message]
        : Array.isArray(body?.message)
          ? body.message.map(String)
          : [`Request failed (${res.status})`];
    const message = parts.join(", ");
    // In the browser, show the API's (English) message in the reader's language.
    // Server components keep it as it is: the dashboard layout reads it.
    const shown = typeof window === "undefined" ? message : parts.map((part) => translateServer(currentBrowserLang(), part)).join(", ");
    throw new ApiError(shown, message, res.status);
  }

  return res.json() as Promise<T>;
}

export type OddsFilter = "upcoming" | "live" | "finished";

/** Super Admin's league picker (GET /odds/leagues). */
export type LeagueChoice = {
  /** False while the defaults apply. */
  custom: boolean;
  leagues: number[];
  countries: string[];
  defaults: { leagues: number[]; countries: string[] };
  /** Every competition the feed has a season in progress for; null when it can't be reached. */
  available: Array<{ id: number; name: string; type: "League" | "Cup"; country: string }> | null;
  availableError: string | null;
  /** Requests left on today's API-Football plan, as of its last answer. */
  requestsLeft: number | null;
};

export type OddsSelection = {
  id: string;
  key: string;
  name: string;
  /** What this team's Players get. */
  price: number;
  /** The feed's price before any margin. Not sent to Players. */
  feedOdds?: number;
  /** True when the Owner set this price by hand. */
  custom: boolean;
  result: "WON" | "LOST" | "VOID" | null;
  /** Live only: the feed isn't pricing this outcome right now. */
  suspended?: boolean;
};

export type PricePoint = { price: number; recordedAt: string };

export type OddsEvent = {
  id: string;
  name: string;
  league: string;
  country: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  startsAt: string;
  status: "UPCOMING" | "LIVE" | "COMPLETED" | "POSTPONED" | "CANCELLED";
  elapsed: number | null;
  homeScore: number | null;
  awayScore: number | null;
  hidden: boolean;
  suspended: boolean;
  provider: string;
  /** Before kick-off, or live with fresh in-play prices. */
  bettable: boolean;
  /** In play. Prices are the feed's live prices less the team margin. */
  live: boolean;
  markets: Array<{ id: string; key: string; name: string; /** Live only: off the board right now. */ suspended?: boolean; selections: OddsSelection[] }>;
};

export type OddsSettings = {
  baseMargin: number;
  team: { ownerId: string; ownerName: string; margin: number; effectiveMargin: number } | null;
  canEditBase: boolean;
  canEditTeam: boolean;
  canManageEvents: boolean;
  feed: { mode: "api-football" | "mock" | "off"; syncedAt: string | null; status: string | null } | null;
  limits: { minOdds: number; maxOdds: number; maxMargin: number };
};

export type BetStatus = "OPEN" | "WON" | "LOST" | "VOID";

export type BetEvent = {
  id: string;
  name: string;
  league: string;
  startsAt: string;
  status: OddsEvent["status"];
  homeScore: number | null;
  awayScore: number | null;
  result: { home: number; away: number } | null;
};

export type BetLeg = {
  name: string;
  market: string;
  odds: number;
  result: "WON" | "LOST" | "VOID" | null;
  voidReason: string | null;
  event: BetEvent;
};

export type Bet = {
  id: string;
  kind: "SINGLE" | "ACCUMULATOR";
  /** An accumulator's picks, in slip order. Empty for singles. */
  legs: BetLeg[];
  description: string | null;
  stake: number;
  odds: number | null;
  /** What a win pays back, stake included. */
  potentialPayout: number | null;
  payout: number;
  status: BetStatus;
  placedAt: string;
  settledAt: string | null;
  voidReason: string | null;
  selection: { name: string; market: string } | null;
  event: BetEvent | null;
};

export type MyBets = { balance: number; open: { count: number; staked: number }; bets: Bet[]; hasMore: boolean };

export type SlipInfo = { balance: number; maxStake: number | null; dailyLossLimit: number | null; blocked: string | null };

export type PlaceBetsResponse = { bets: Bet[]; total: number };

export type AdminBet = Bet & { player: { id: string; username: string } };

export type SettlementEvent = {
  id: string;
  name: string;
  league: string;
  startsAt: string;
  status: OddsEvent["status"];
  homeScore: number | null;
  awayScore: number | null;
  result: { home: number; away: number } | null;
  /** The half-time score the 1st and 2nd half markets settle on. */
  halfTime: { home: number; away: number } | null;
  /** Corners and cards the corner and card markets settle on. */
  stats: { cornersHome: number; cornersAway: number; cardsHome: number; cardsAway: number } | null;
  statsSource: "feed" | "manual" | null;
  /** Went to extra time, so corners and cards must be entered by hand. */
  extraTime: boolean;
  resultSource: "feed" | "manual" | null;
  suspended: boolean;
  bets: { open: number; total: number; staked: number; openStaked: number };
  needsAttention: boolean;
};

export type RiskExposure = { bets: number; staked: number; payout: number };

export type RiskSelection = {
  id: string;
  name: string;
  singles: RiskExposure;
  accumulators: RiskExposure;
  /** Everything the team pays out if this outcome wins. */
  payout: number;
  /** Singles only: the team's result on this market if this outcome wins. */
  singlesResult: number;
  overCap: boolean;
  /** Payout as a share of the cap, 0 to 1, or null with no cap. */
  share: number | null;
};

export type RiskEvent = {
  id: string;
  name: string;
  league: string;
  startsAt: string;
  status: OddsEvent["status"];
  homeScore: number | null;
  awayScore: number | null;
  bets: { singles: number; accumulators: number };
  singlesStaked: number;
  worst: { selection: string; market: string; payout: number };
  markets: Array<{ id: string; name: string; selections: RiskSelection[] }>;
};

export type RiskView = {
  owner: { id: string; username: string };
  cap: number | null;
  canEdit: boolean;
  totals: { openBets: number; staked: number; worstCase: number };
  events: RiskEvent[];
};
