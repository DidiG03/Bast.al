// Run with `npm test --workspace apps/api` (builds first). Covers who can be
// locked out and rate limited: only a visitor's own address, never a shared
// proxy one; refused accounts that aren't attacks; and deleting accounts
// without losing money history.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuthGuard } from "../dist/auth/auth.guard.js";
import { isVisitorAddress } from "../dist/security/client-ip.js";
import { ClientThrottlerGuard } from "../dist/security/client-throttler.guard.js";
import { ThreatIntelService } from "../dist/security/threat-intel.service.js";
import { UsersService } from "../dist/users/users.service.js";

/** In-memory lockouts (no Redis), 3 failures to a ban. */
function threats() {
  const settings = { SECURITY_FAIL_LIMIT: "3" };
  return new ThreatIntelService({ get: (name) => settings[name] });
}

const request = (ip, headers = {}) => ({ headers, ip, socket: { remoteAddress: ip } });
const httpContext = (req) => ({ switchToHttp: () => ({ getRequest: () => req }) });

test("only a visitor's own address counts as theirs", () => {
  for (const ip of ["84.20.70.1", "2a02:2f0c::1", "8.8.8.8"]) assert.equal(isVisitorAddress(ip), true, ip);
  for (const ip of ["100.64.0.19", "10.0.0.5", "172.20.1.1", "192.168.1.10", "127.0.0.1", "::1", "fd12:3456::1", "fe80::1", "unknown", "", null]) {
    assert.equal(isVisitorAddress(ip), false, String(ip));
  }
});

test("failures from a shared proxy address never lock anyone out", async () => {
  const intel = threats();
  for (let i = 0; i < 10; i++) assert.deepEqual(await intel.recordFailure("100.64.0.19"), { banned: false, failures: 0 });
  await intel.ban("100.64.0.19", "honeypot_get");
  assert.equal(await intel.isBlocked("100.64.0.19"), false, "the proxy address everyone shares stays open");

  // A visitor's own address is still locked out as before.
  await intel.recordFailure("84.20.70.1");
  await intel.recordFailure("84.20.70.1");
  assert.equal((await intel.recordFailure("84.20.70.1")).banned, true);
  await intel.ban("84.20.70.1", "invalid_clerk_token");
  assert.equal(await intel.isBlocked("84.20.70.1"), true);
});

test("a key is new only once per window", async () => {
  const intel = threats();
  assert.equal(await intel.firstInWindow("auth-refused:u1", 60_000), true);
  assert.equal(await intel.firstInWindow("auth-refused:u1", 60_000), false);
  assert.equal(await intel.firstInWindow("auth-refused:u2", 60_000), true);
});

/** An AuthGuard whose session is valid and whose account is `user` (null = not in our database). */
function guardFor(user, { ancestorSuspended = false, session = { userId: "clerk_1", sessionId: "sess_1" } } = {}) {
  const logged = [];
  const intel = threats();
  const prisma = {
    user: { findUnique: async () => user },
    $queryRaw: async () => [{ blocked: ancestorSuspended }],
    loginHistory: { upsert: async () => undefined },
  };
  const clerk = { sessionFor: async () => session };
  const guard = new AuthGuard(clerk, prisma, { log: async (entry) => logged.push(entry) }, intel);
  return { guard, logged, intel };
}

const suspendedPlayer = { id: "p1", clerkId: "clerk_1", role: "PLAYER", status: "SUSPENDED", parentId: "m1" };

test("a suspended account's open tab never gets its address locked out", async () => {
  const { guard, logged, intel } = guardFor(suspendedPlayer);
  const req = request("84.20.70.1", { authorization: "Bearer token" });
  for (let i = 0; i < 12; i++) await assert.rejects(guard.canActivate(httpContext(req)), ForbiddenException);
  assert.equal(await intel.isBlocked("84.20.70.1"), false);
  assert.equal(logged.length, 1, "recorded once, not on every request");
  assert.equal(logged[0].action, "auth.refused");
  assert.equal(logged[0].metadata.reason, "suspended");
});

test("an account under a suspended Owner is refused the same quiet way", async () => {
  const { guard, logged, intel } = guardFor({ ...suspendedPlayer, status: "ACTIVE" }, { ancestorSuspended: true });
  const req = request("84.20.70.1", { authorization: "Bearer token" });
  for (let i = 0; i < 12; i++) await assert.rejects(guard.canActivate(httpContext(req)), /an account above it is suspended/);
  assert.equal(await intel.isBlocked("84.20.70.1"), false);
  assert.equal(logged.length, 1);
});

test("a signed-in person with no account here is refused without a lockout", async () => {
  const { guard, logged, intel } = guardFor(null);
  const req = request("84.20.70.1", { authorization: "Bearer token" });
  for (let i = 0; i < 12; i++) await assert.rejects(guard.canActivate(httpContext(req)), /not provisioned/);
  assert.equal(await intel.isBlocked("84.20.70.1"), false);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].metadata.clerkUserId, "clerk_1");
});

test("requests with no valid session still lock out the visitor who sends them", async () => {
  const { guard, intel } = guardFor(null, { session: null });
  const req = request("84.20.70.1");
  for (let i = 0; i < 3; i++) await assert.rejects(guard.canActivate(httpContext(req)), UnauthorizedException);
  assert.equal(await intel.isBlocked("84.20.70.1"), true);
  await assert.rejects(guard.canActivate(httpContext(req)), /Temporarily blocked/);
});

test("rate limits follow the signed-in account, not the address", async () => {
  const sessions = new Map([["Bearer good", { userId: "user_42" }]]);
  const clerk = { sessionFor: async (req) => sessions.get(req.headers.authorization) ?? null };
  const guard = new ClientThrottlerGuard({ throttlers: [] }, {}, {}, clerk);
  assert.equal(await guard.getTracker(request("100.64.0.19", { authorization: "Bearer good" })), "user:user_42");
  assert.equal(await guard.getTracker(request("100.64.0.19", { authorization: "Bearer made-up" })), "ip:100.64.0.19", "an unverified token gets no allowance of its own");
  assert.equal(await guard.getTracker(request("84.20.70.1")), "ip:84.20.70.1");
});

/** A UsersService with only what deleteUser touches. `history` says which kinds of money history the target has. */
function deletion({ history = {}, balance = "0", children = 0 } = {}) {
  const calls = [];
  const target = { id: "p1", clerkId: "clerk_p1", username: "ardi", role: "PLAYER", parentId: "m1", balance: new Prisma.Decimal(balance) };
  const found = (kind) => async () => (history[kind] ? { id: "x" } : null);
  const tx = {
    auditLog: { updateMany: async () => calls.push("audit nulled") },
    user: { delete: async () => calls.push("row deleted") },
  };
  const prisma = {
    user: { findUnique: async () => target, count: async () => children },
    bet: { findFirst: found("bet") },
    casinoSpin: { findFirst: found("spin") },
    balanceTransaction: { findFirst: found("ledger") },
    commissionPayout: { findFirst: found("payout") },
    $transaction: async (fn) => fn(tx),
  };
  const clerk = { deleteUserStrict: async () => calls.push("sign-in deleted") };
  const hierarchy = { canActOn: async () => true };
  const audit = { log: async (entry) => calls.push(entry.action) };
  const service = new UsersService(prisma, clerk, hierarchy, audit, {}, {}, {});
  const manager = { id: "m1", role: "MANAGER" };
  return { remove: () => service.deleteUser(manager, "p1"), calls };
}

test("an account with bets, casino spins, ledger entries or commission payouts can't be deleted", async () => {
  for (const kind of ["bet", "spin", "ledger", "payout"]) {
    const { remove, calls } = deletion({ history: { [kind]: true } });
    await assert.rejects(remove(), /has bets or money history.*Suspend it instead/, kind);
    assert.deepEqual(calls, [], `nothing is touched (${kind})`);
  }
});

test("an account made by mistake is deleted, sign-in last", async () => {
  const { remove, calls } = deletion();
  assert.deepEqual(await remove(), { id: "p1" });
  assert.deepEqual(calls, ["audit nulled", "audit nulled", "row deleted", "sign-in deleted", "user.delete"]);
});

test("accounts with someone under them still can't be deleted", async () => {
  const { remove } = deletion({ children: 2 });
  await assert.rejects(remove(), /2 direct child account/);
});
