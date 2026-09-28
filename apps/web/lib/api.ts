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
  type: "DELEGATION" | "RECLAIM" | "ADJUSTMENT";
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
  sessions: Array<{ id: string; status: string; lastActiveAt: number; expireAt: number; abandonAt: number | null }>;
  activity: Array<{ id: string; action: string; ipAddress: string | null; metadata: unknown; createdAt: string }>;
  loginHistory: Array<{ id: string; sessionId: string; ipAddress: string | null; device: string | null; browser: string | null; location: string | null; lastSeenAt: string; createdAt: string }>;
};

export type NotificationItem = {
  id: string;
  type: "FUNDS_RECEIVED" | "FUNDS_RECLAIMED" | "APPROVAL_REQUESTED" | "COMMISSION_RATE_UPDATED" | "ACCOUNT_SUSPENDED" | "ACCOUNT_UPDATED" | "ACCOUNT_REASSIGNED" | "SUSPICIOUS_LOGIN";
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

export function transactionLabel(type: BalanceEntry["type"]): string {
  return type === "DELEGATION" ? "Delegation" : type === "RECLAIM" ? "Reclaim" : "Adjustment";
}

export type CommissionRateResponse = { rate: number };

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
    const message =
      typeof body?.message === "string"
        ? body.message
        : Array.isArray(body?.message)
          ? body.message.join(", ")
          : `Request failed (${res.status})`;
    throw new Error(message);
  }

  return res.json() as Promise<T>;
}
