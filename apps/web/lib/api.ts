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
  /** Player only: the Casino tab is open to them (the site's switch and their Owner's are on). */
  casinoOpen?: boolean;
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
  /** `returnedBalance` goes back to `returnedTo`, the Manager or Owner the Player leaves. */
  impact: { movedAccounts: number; currentManagerId: string | null; returnedBalance: number; returnedTo: string | null };
};

export type CreateUserRequest = {
  username: string;
  password: string;
  role: "OWNER" | "MANAGER" | "PLAYER";
  parentId?: string;
};

export type BalanceEntry = {
  id: string;
  /** CASINO: one line per day for all of the day's spins, net. */
  type: "DELEGATION" | "RECLAIM" | "ADJUSTMENT" | "BET_STAKE" | "BET_SETTLEMENT" | "CASINO";
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

/** Super Admin: what deleting all test data would remove right now. `enabled` is false when the server has it turned off. */
export type DataResetPreview = { enabled: boolean; accounts: number; bets: number; ledgerEntries: number; notifications: number; auditEntries: number };
export type DataResetResult = { accounts: number; bets: number; ledgerEntries: number; commissionPayouts: number; signIns: number };

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
  CASINO: msg("Casino"),
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

/** `commission`: what this Player's results earn their Manager (0 without one). */
export type PlayerResult = CommissionTotals & { id: string; username: string; status: UserRow["status"]; commission: number };

/**
 * Where one commission relationship stands (Super Admin and an Owner, or an
 * Owner and a Manager). Losses carry over: a payment covers everything since
 * the previous one, so a losing week is made up before more is paid.
 */
export type PayoutStanding = {
  /** The end of the last payment, if any. */
  paidUpTo: string | null;
  /** Where a payment now would start. Null when already paid up to the period's end. */
  start: string | null;
  /** The commission from `start` to the period's end; below zero while losses are still being made up. */
  balance: number;
  /** What a payment now would be. */
  due: number;
};

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
  owners: Array<OwnerSplit & { id: string; username: string; status: UserRow["status"]; commissionRate: number; managers: number; players: number; payout: PayoutStanding }>;
};

export type TeamCommissions = CommissionPeriod & {
  owner: { id: string; username: string; commissionRate: number };
  totals: OwnerSplit;
  /** Where the Owner stands with Super Admin. */
  ownerPayout: PayoutStanding;
  managers: Array<CommissionTotals & { id: string; username: string; status: UserRow["status"]; commissionRate: number; commission: number; players: PlayerResult[]; payout: PayoutStanding }>;
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
  /** Where this Manager stands with their Owner. */
  payout: PayoutStanding;
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

/**
 * Browser only: the last answer to each GET fetched with `revalidate`, and
 * its ETag. Asked again, the API answers 304 with no body when nothing
 * changed, and the very same object comes back, so a page can tell nothing
 * moved without comparing anything.
 */
const revalidated = new Map<string, { etag: string; body: unknown }>();
const REVALIDATED_KEPT = 40;

export async function apiFetch<T>(
  path: string,
  token: string,
  init?: RequestInit & { idempotencyKey?: string; revalidate?: boolean },
): Promise<T> {
  const normalized = path.startsWith("/") ? path.slice(1) : path;
  const { idempotencyKey, revalidate, ...rest } = init ?? {};
  const url = `${apiBase()}/${normalized}`;
  const cached = revalidate && typeof window !== "undefined" && (rest.method ?? "GET") === "GET" ? revalidated.get(url) : undefined;
  const res = await fetch(url, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      ...(cached ? { "If-None-Match": cached.etag } : {}),
      ...(rest.headers ?? {}),
    },
    cache: "no-store",
  });

  if (res.status === 304 && cached) return cached.body as T;

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

  const body = (await res.json()) as T;
  const etag = res.headers.get("etag");
  if (revalidate && typeof window !== "undefined" && etag) {
    revalidated.delete(url);
    revalidated.set(url, { etag, body });
    if (revalidated.size > REVALIDATED_KEPT) revalidated.delete(revalidated.keys().next().value!);
  }
  return body;
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
  /** The highest price the Owner can set by hand: a little above the feed price. Before kick-off only; not sent to Players. */
  maxPrice?: number;
  /** True when the Owner set this price by hand. */
  custom: boolean;
  result: "WON" | "LOST" | "VOID" | null;
  /** Live: the feed isn't pricing this outcome right now. Before kick-off: the feed took it down (a player left out, a line removed). */
  suspended?: boolean;
  /** Greyhounds: paid at the starting price (Winner) or the forecast dividend (Forecast); `price` is 0. */
  sp?: boolean;
  /** Greyhounds: the dog's trap and trainer (Winner), or the pair's traps (Forecast). */
  info?: { trap?: number; trainer?: string | null; traps?: [number, number] } | null;
};

export type PricePoint = { price: number; recordedAt: string };

export type Sport = "football" | "greyhounds" | "mma" | "basketball" | "nfl" | "tennis" | "volleyball" | "handball";

/** Greyhounds: the race's details. A withdrawn dog shows as a suspended pick. */
export type RaceInfo = { raceNumber: number | null; grade: string | null; distance: number | null; region: string | null };
/** Greyhounds: the official result, once it's in. */
export type RaceResult = { final: boolean; positions: Array<{ dogId: number; position: number; sp: number | null }>; forecastDividend: number | null; tricastDividend?: number | null };

export type OddsEvent = {
  id: string;
  sport?: Sport;
  /** Greyhounds only. */
  race?: RaceInfo | null;
  raceResult?: RaceResult | null;
  name: string;
  league: string;
  country: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  startsAt: string;
  status: "UPCOMING" | "LIVE" | "COMPLETED" | "POSTPONED" | "CANCELLED";
  elapsed: number | null;
  /** While live, the feed's phase: "FT" once it's over (also for a match that just finished), "HT" at half-time, "BT" before extra time, "SUSP"/"INT" when interrupted. */
  period?: string | null;
  homeScore: number | null;
  awayScore: number | null;
  hidden: boolean;
  suspended: boolean;
  provider: string;
  /** Before kick-off, or live with fresh in-play prices. */
  bettable: boolean;
  /** Live only: why bets are paused right now, if they are. */
  livePause?: "goal" | "swing" | "reopen" | "late" | "feed" | null;
  /** In play. Prices are the feed's live prices less the team margin. */
  live: boolean;
  /** Every market the match has. The list view (`view=list`) sends only the first; `/odds/events/:id` sends them all. */
  marketCount: number;
  markets: Array<{ id: string; key: string; name: string; /** Live only: off the board right now. */ suspended?: boolean; selections: OddsSelection[] }>;
};

/** A bet slip pick's price right now, from `/odds/selections`. */
export type SelectionQuote = {
  id: string;
  eventId: string;
  price: number;
  /** Can be bet on right now. */
  bettable: boolean;
  /** Live: off the board for now. Before kick-off: the feed took it down. */
  suspended: boolean;
  live: boolean;
  /** Before kick-off or in play; false once the match is over. */
  open: boolean;
  /** Greyhounds: paid at the starting price; `price` is 0. */
  sp?: boolean;
};

export type OddsSettings = {
  baseMargin: number;
  team: { ownerId: string; ownerName: string; margin: number; effectiveMargin: number } | null;
  canEditBase: boolean;
  canEditTeam: boolean;
  canManageEvents: boolean;
  feed: { mode: "api-football" | "mock" | "off"; syncedAt: string | null; status: string | null } | null;
  /** `maxAboveFeed`: how far above the feed price an Owner's own price can go, in percent. */
  limits: { minOdds: number; maxOdds: number; maxMargin: number; maxAboveFeed: number };
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
  kind: "SINGLE" | "ACCUMULATOR" | "BUILDER" | "SYSTEM";
  /** A system bet: its name ("Yankee", "2 from 4"), line sizes, stake per line, number of lines and most it can return. */
  system?: { name: string; sizes: number[]; lineStake: number; lines: number; maxReturn: number } | null;
  /** An accumulator's or a bet builder's picks, in slip order. Empty for singles. */
  legs: BetLeg[];
  description: string | null;
  stake: number;
  odds: number | null;
  /** What a win pays back, stake included. */
  potentialPayout: number | null;
  /** Greyhounds: paid at the starting price (or forecast dividend), up to `spCap`; `odds` is set when it settles. */
  sp?: boolean;
  spCap?: number | null;
  payout: number;
  status: BetStatus;
  placedAt: string;
  settledAt: string | null;
  voidReason: string | null;
  selection: { name: string; market: string } | null;
  event: BetEvent | null;
};

export type MyBets = {
  balance: number;
  open: { count: number; staked: number };
  /** Bets settled in the last 7 days: what went on them and what came back. */
  week: { count: number; staked: number; returned: number };
  bets: Bet[];
  hasMore: boolean;
};

export type SlipInfo = {
  balance: number;
  maxStake: number | null;
  dailyLossLimit: number | null;
  /** Today's losses plus today's stakes still open: how much of the daily loss limit is used. */
  dailyLossUsed: number;
  blocked: string | null;
};

export type PlaceBetsResponse = { bets: Bet[]; total: number };

/** The bet builder's price for picks from one match, and each pick's own price in it. */
export type BuilderQuote = { odds: number; legs: Array<{ selectionId: string; odds: number }> };

export type AdminBet = Bet & { player: { id: string; username: string } };

export type SettlementEvent = {
  id: string;
  /** "greyhounds": a race, which has no score to set; its picks are settled one by one. */
  sport?: Sport;
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
  /** Super Admin only: picks of a finished match the feed couldn't settle (e.g. a goalscorer whose name matches no one for sure). */
  waiting: Array<{ selectionId: string; market: string; name: string; bets: number }>;
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

/** The casino slot's symbols, as the API names them. */
export type SlotSymbol = "SEVEN" | "MELON" | "GRAPES" | "PLUM" | "ORANGE" | "LEMON" | "CHERRY" | "STAR";
export type CardColor = "RED" | "BLACK";
export type CardSuit = "HEARTS" | "DIAMONDS" | "CLUBS" | "SPADES";

/** One spin in a Player's recent list. A free spin has `stake` 0 and plays at `bet`. */
/** A spin, or one guess at double or nothing (kind GAMBLE: the bet is the win at risk). */
export type CasinoSpinRow = {
  id: string;
  kind: "SPIN" | "GAMBLE";
  bet: number;
  stake: number;
  win: number;
  free: boolean;
  freeSpinsWon: number;
  gamble: { pick: CardColor; suit: CardSuit; game?: "slot" | "book" } | null;
  createdAt: string;
};

/** A win the Player can still take to double or nothing. */
export type CasinoGamble = { amount: number; steps: number; stepsLeft: number };

export type CasinoFreeSpins = { remaining: number; bet: number };

/** The Player's Casino: whether they can play (`closed` says why not), the rules, and where they stand. */
export type CasinoState = {
  closed: string | null;
  balance: number;
  maxStake: number | null;
  freeSpins: CasinoFreeSpins | null;
  /** grid[reel][row] the reels rest on before the first spin; null before any spin. */
  grid: SlotSymbol[][] | null;
  recent: CasinoSpinRow[];
  /** The last win, if the Player can still take it to double or nothing. */
  gamble: CasinoGamble | null;
  game: {
    /** What Players see the game called. */
    name: string;
    reels: number;
    rows: number;
    lines: number;
    bets: number[];
    symbols: SlotSymbol[];
    scatter: SlotSymbol;
    /** For each line, the row it runs through on each reel. */
    lineShapes: number[][];
    /** In line bets (a fifth of the bet): [2, 3, 4, 5] in a row; 0 doesn't pay. */
    linePays: Partial<Record<SlotSymbol, [number, number, number, number]>>;
    scatterPays: Record<"3" | "4" | "5", number>;
    payoutRate: number;
    /** Double or nothing: at most this many guesses, and never for more than this many dollars. */
    gambleSteps: number;
    gambleLimit: number;
  };
};

/** `cells` are [reel, row]; `win` is in dollars. */
export type CasinoWinningLine = { line: number; symbol: SlotSymbol; count: number; cells: Array<[number, number]>; win: number };

export type CasinoSpinResult = {
  spin: CasinoSpinRow;
  grid: SlotSymbol[][];
  lines: CasinoWinningLine[];
  scatter: { count: number; cells: Array<[number, number]>; win: number } | null;
  win: number;
  free: boolean;
  freeSpinsWon: number;
  freeSpins: CasinoFreeSpins | null;
  gamble: CasinoGamble | null;
  balance: number;
};

export type CasinoGambleResult = {
  spin: CasinoSpinRow;
  suit: CardSuit;
  color: CardColor;
  won: boolean;
  /** What the Player now has from this win: double, or nothing. */
  win: number;
  /** Null when it's over: lost, or won and at the limit. */
  gamble: CasinoGamble | null;
  balance: number;
};

/** Super Admin, Owners and Managers: whether the Casino is open, and how it did in a period, per Player. */
export type CasinoAdmin = {
  from: string;
  to: string;
  siteOpen: boolean;
  canSwitchSite: boolean;
  teams: Array<{ ownerId: string; username: string; open: boolean }>;
  /** A Manager's team: whether their Owner has the Casino open. Null for others. */
  teamOpen: boolean | null;
  totals: { spins: number; staked: number; won: number; net: number; payoutRate: number | null };
  /** Each game on its own: the slot (spins and double or nothing), roulette, blackjack (`spins` are its hands), Mines and Penalty (`spins` are their rounds), Plinko (`spins` are its balls) and Dice (`spins` are its rolls). */
  games: Record<"slot" | "roulette" | "blackjack" | "mines" | "penalty" | "plinko" | "dice", { spins: number; staked: number; won: number; payoutRate: number | null }> & {
    /** Book of Ra: paid spins and free ones, with double or nothing on its wins. */
    book: { spins: number; freeSpins: number; staked: number; won: number; payoutRate: number | null };
  };
  players: Array<{
    id: string;
    username: string;
    spins: number;
    roulette: { spins: number; staked: number; won: number };
    blackjack: { hands: number; staked: number; won: number };
    book: { spins: number; freeSpins: number; staked: number; won: number };
    mines: { rounds: number; staked: number; won: number };
    penalty: { rounds: number; staked: number; won: number };
    plinko: { balls: number; staked: number; won: number };
    dice: { rolls: number; staked: number; won: number };
    staked: number;
    won: number;
    net: number;
  }>;
};

/** Book of Ra's symbols, as the API names them. */
export type BookSymbol = "EXPLORER" | "PHARAOH" | "STATUE" | "SCARAB" | "ACE" | "KING" | "QUEEN" | "JACK" | "TEN" | "BOOK";
export type BookPaying = Exclude<BookSymbol, "BOOK">;

/** A round of free spins in progress: every spin plays at `bet`, and `special` expands. `won` is the round's total so far, the spin that started it included. */
export type BookFeature = { bet: number; special: BookPaying; remaining: number; played: number; won: number };

/** One Book of Ra spin in the Player's recent list. A free spin has `stake` 0 and `special` set. */
export type BookSpinRow = { id: string; bet: number; stake: number; win: number; free: boolean; freeSpinsWon: number; special: BookPaying | null; createdAt: string };

export type BookState = {
  closed: string | null;
  balance: number;
  maxStake: number | null;
  grid: BookSymbol[][] | null;
  feature: BookFeature | null;
  gamble: CasinoGamble | null;
  recent: BookSpinRow[];
  game: {
    name: string;
    reels: number;
    rows: number;
    lines: number;
    bets: number[];
    symbols: BookSymbol[];
    book: BookSymbol;
    paying: BookPaying[];
    lineShapes: number[][];
    /** In line bets (a tenth of the bet): [2, 3, 4, 5] of a kind; 0 doesn't pay. */
    linePays: Record<BookPaying, [number, number, number, number]>;
    /** Books anywhere, in times the whole bet. */
    scatterPays: Record<"3" | "4" | "5", number>;
    /** How many reels each symbol must be on to expand and pay in free spins. */
    expandsFrom: Record<BookPaying, number>;
    freeSpins: number;
    maxWin: number;
    payoutRate: number;
    gambleSteps: number;
    gambleLimit: number;
  };
};

export type BookSpinResult = {
  spin: BookSpinRow;
  grid: BookSymbol[][];
  lines: Array<{ line: number; symbol: BookPaying; count: number; cells: Array<[number, number]>; win: number }>;
  scatter: { count: number; cells: Array<[number, number]>; win: number } | null;
  /** In a free spin: the special symbol filling `reels`, paying `perLine` on every line. Dollars. */
  expansion: { symbol: BookPaying; reels: number[]; perLine: number; win: number } | null;
  win: number;
  free: boolean;
  freeSpinsWon: number;
  feature: BookFeature | null;
  /** The round's total, when this was its last free spin. */
  featureEnded: number | null;
  /** The round reached the most it can pay. */
  capped: boolean;
  gamble: CasinoGamble | null;
  balance: number;
};

/** A card: rank (A, 2–9, T, J, Q, K) then suit (S, H, D, C), "AS", "TD". */
export type PlayingCardCode = string;
export type BlackjackAction = "hit" | "stand" | "double" | "split" | "insure" | "noInsurance";
export type BlackjackResultKind = "BLACKJACK" | "WIN" | "PUSH" | "LOSE" | "BUST";

/** A blackjack round as the Player may see it: the dealer's face-down card is null until the round ends. */
export type BlackjackRoundView = {
  phase: "INSURANCE" | "PLAYER" | "DONE";
  dealer: Array<PlayingCardCode | null>;
  dealerTotal: number;
  dealerSoft: boolean;
  hands: Array<{
    cards: PlayingCardCode[];
    total: number;
    soft: boolean;
    blackjack: boolean;
    bet: number;
    doubled: boolean;
    done: boolean;
    result: BlackjackResultKind | null;
    /** What the hand paid back, its bet included. */
    payout: number;
  }>;
  /** The hand being played. */
  active: number;
  /** Insurance taken, 0 if declined, null when not asked. */
  insurance: number | null;
  insurancePayout: number;
  /** The moves open now. */
  allowed: BlackjackAction[];
  /** Everything put down this round. */
  staked: number;
  /** Everything paid back, once the round is over; null before. */
  payout: number | null;
};

/** A finished round in the Player's list. */
export type BlackjackPastRound = {
  id: string;
  bet: number;
  staked: number;
  win: number;
  dealer: PlayingCardCode[];
  dealerTotal: number;
  hands: Array<{ cards: PlayingCardCode[]; total: number; blackjack: boolean; result: BlackjackResultKind | null }>;
  createdAt: string;
};

export type BlackjackState = {
  closed: string | null;
  balance: number;
  /** The most a first bet can be: the Player's max stake, or the table's own limit. */
  tableMax: number;
  /** A round still being played, to carry on with. */
  round: BlackjackRoundView | null;
  recent: BlackjackPastRound[];
  game: { name: string; chips: number[]; payoutRate: number };
};

export type BlackjackMoveResult = { round: BlackjackRoundView; balance: number };

export type RouletteColor = "RED" | "BLACK" | "GREEN";

/** One round of roulette in the Player's list: the number, and what each spot had on it and paid (its stake included). */
export type RouletteRound = {
  id: string;
  number: number;
  label: string;
  color: RouletteColor;
  staked: number;
  win: number;
  bets: Array<{ spot: string; amount: number; win: number }>;
  createdAt: string;
};

/** The Player's roulette table: whether they can play (`closed` says why not), the rules and their last rounds. */
export type RouletteState = {
  closed: string | null;
  balance: number;
  /** The most all the chips on the table can add up to in one spin: the Player's max stake, or the table's own limit. */
  tableMax: number;
  recent: RouletteRound[];
  /** The last numbers, newest first. */
  history: Array<{ number: number; label: string; color: RouletteColor }>;
  game: {
    name: string;
    /** The pockets in order round the wheel, from 0. */
    wheel: number[];
    red: number[];
    chips: number[];
    maxSpots: number;
    payoutRate: number;
  };
};

export type RouletteResult = {
  round: RouletteRound;
  /** Where the wheel stopped: an index into the wheel. */
  stop: number;
  number: number;
  label: string;
  color: RouletteColor;
  staked: number;
  win: number;
  winners: Array<{ spot: string; amount: number; win: number }>;
  balance: number;
};

export type MinesPhase = "PLAY" | "WON" | "LOST";
export type MinesTile = "hidden" | "gem" | "mine" | "hit";

/** A Mines round as the Player may see it. Tiles stay hidden until the round ends. */
export type MinesRoundView = {
  phase: MinesPhase;
  mines: number;
  bet: number;
  opened: number;
  multiplier: number;
  nextMultiplier: number | null;
  cashout: number;
  capped: boolean;
  tiles: MinesTile[];
};

export type MinesRoundRow = MinesRoundView & { id: string; createdAt: string };

export type MinesState = {
  closed: string | null;
  balance: number;
  /** The most one round can stake: the Player's max stake, or the top chip without one. */
  tableMax: number;
  round: MinesRoundView | null;
  recent: MinesRoundRow[];
  game: {
    name: string;
    bets: number[];
    mineCounts: number[];
    tiles: number;
    columns: number;
    payoutRate: number;
    maxWin: number;
  };
};

export type MinesStepResult = {
  round: MinesRoundView;
  balance: number;
};

export type PenaltyDirection = "LEFT" | "CENTER" | "RIGHT";
export type PenaltyPhase = "PLAY" | "WON" | "LOST";

/** One kick the Player has already taken: where they aimed, where the keeper went, and whether it scored. */
export type PenaltyKick = { aim: PenaltyDirection; dive: PenaltyDirection; goal: boolean };

/** A penalty shootout as the Player may see it. The next dive isn't chosen until they kick. */
export type PenaltyRoundView = {
  phase: PenaltyPhase;
  bet: number;
  goals: number;
  multiplier: number;
  nextMultiplier: number | null;
  cashout: number;
  capped: boolean;
  kicks: PenaltyKick[];
};

export type PenaltyRoundRow = PenaltyRoundView & { id: string; createdAt: string };

export type PenaltyState = {
  closed: string | null;
  balance: number;
  /** The most one shootout can stake: the Player's max stake, or the top chip without one. */
  tableMax: number;
  round: PenaltyRoundView | null;
  recent: PenaltyRoundRow[];
  game: {
    name: string;
    bets: number[];
    directions: PenaltyDirection[];
    /** What stopping after the first `fullPriceGoals` goals pays back, in percent. */
    payoutRate: number;
    fullPriceGoals: number;
    /** What each later goal multiplies by, below the fair 1.5. */
    laterStep: number;
    maxWin: number;
  };
};

export type PenaltyStepResult = {
  round: PenaltyRoundView;
  balance: number;
};

export type PlinkoRows = 8 | 12 | 16;
export type PlinkoRisk = "LOW" | "MEDIUM" | "HIGH";

/** One Plinko ball: the board it fell through, each row's bounce (0 left, 1 right), and the bucket it landed in. */
export type PlinkoBall = {
  id: string;
  rows: PlinkoRows;
  risk: PlinkoRisk;
  path: number[];
  bucket: number;
  multiplier: number;
  bet: number;
  win: number;
  createdAt: string;
};

export type PlinkoState = {
  closed: string | null;
  balance: number;
  /** The most one ball can cost: the Player's max stake, or the top chip without one. */
  tableMax: number;
  recent: PlinkoBall[];
  game: {
    name: string;
    bets: number[];
    rows: PlinkoRows[];
    risks: PlinkoRisk[];
    /** Every bucket's multiplier, left to right, by rows and then risk. */
    pays: Record<PlinkoRows, Record<PlinkoRisk, number[]>>;
    /** What each board pays back on average, in percent. */
    payoutRates: Record<PlinkoRows, Record<PlinkoRisk, number>>;
    payoutRate: number;
    /** The most a ball pays, in times its stake. */
    maxWin: number;
  };
};

export type PlinkoDropResult = {
  round: PlinkoBall;
  balance: number;
};

/** A Player's dice seed pair. The server seed stays null until the Player changes seeds. */
export type DiceSeed = {
  serverSeedHash: string;
  clientSeed: string;
  /** The next roll's nonce: how many rolls the pair has made. */
  nonce: number;
  serverSeed: string | null;
};

/** One dice roll. Target and roll are in points (42.73); chance in percent. */
export type DiceRoll = {
  id: string;
  target: number;
  direction: "UNDER" | "OVER";
  roll: number;
  chance: number;
  multiplier: number;
  won: boolean;
  bet: number;
  win: number;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  serverSeed: string | null;
  createdAt: string;
};

export type DiceState = {
  closed: string | null;
  balance: number;
  /** The most one roll can cost: the Player's max stake, or the game's top without one. */
  tableMax: number;
  recent: DiceRoll[];
  seed: DiceSeed;
  previousSeed: DiceSeed | null;
  game: {
    name: string;
    outcomes: number;
    payoutRate: number;
    minChance: number;
    maxChance: number;
    minBet: number;
    maxBet: number;
    maxMultiplier: number;
  };
};

export type DiceRollResult = {
  round: DiceRoll;
  balance: number;
  seed: DiceSeed;
};

export type DiceSeedChange = {
  seed: DiceSeed;
  previousSeed: DiceSeed;
};
