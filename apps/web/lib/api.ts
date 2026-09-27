function apiBase(): string {
  // Browser → Next BFF (adds HMAC). Server components → Nest directly.
  if (typeof window !== "undefined") {
    return "/api/backend";
  }
  return `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"}/api`;
}

export type MeResponse = {
  id: string;
  username: string;
  role: "SUPER_ADMIN" | "OWNER" | "MANAGER" | "PLAYER";
  parentId: string | null;
  status: "ACTIVE" | "SUSPENDED";
  balance: number | string;
  commissionRate: number | string;
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
  commissionRate: number | string;
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
  type: "DELEGATION" | "ADJUSTMENT";
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
  type: "FUNDS_RECEIVED" | "ACCOUNT_SUSPENDED" | "ACCOUNT_UPDATED" | "ACCOUNT_REASSIGNED" | "SUSPICIOUS_LOGIN";
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
  owners: Array<{ id: string; username: string; status: UserRow["status"]; balance: number; commissionRate: number; directReports: number }>;
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
  recipients: Array<{ userId: string; username: string; role: MeResponse["role"]; totalDelegated: number }>;
};

export type CommissionRateResponse = { rate: number };

export async function apiFetch<T>(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<T> {
  const normalized = path.startsWith("/") ? path.slice(1) : path;
  const res = await fetch(`${apiBase()}/${normalized}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
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
