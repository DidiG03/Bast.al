// Late live bets, looked at again: for each live bet one Player placed since
// a time (player_001 since yesterday 00:00 UTC by default), everything the
// late check goes on, what the check decided before (if it ever ran on it),
// and what the rule in force now decides (bets/late.ts). Only reports unless
// --apply is given; then the settled ones it finds late are voided the same
// way the settlement sweep does (SettlementService.recheckLate): winnings
// taken back, the Player told, every decision logged and audited. Open bets
// are left to settlement, which runs the same check before paying them.
//
//   npm run build --workspace apps/api
//   DATABASE_URL=… node apps/api/scripts/late-recheck.mjs [--player player_001] [--since 2026-10-24T00:00:00Z] [--apply]
//
// With API_FOOTBALL_KEY set, a finished match without the feed's timeline has
// it fetched first (that stores the timeline, nothing else). FIELD_ENCRYPTION_KEY
// is needed with --apply, for the Players' notifications.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("reflect-metadata");
const dist = new URL("../dist/", import.meta.url).pathname;
const { Prisma, PrismaClient } = require("@prisma/client");
const { lateDecision, liveStateOf, timelineOf, minuteStart, kickOffFromClock, LATE_RULE_VERSION } = require(`${dist}bets/late.js`);
const { SettlementService } = require(`${dist}bets/settlement.service.js`);
const { OddsSyncService } = require(`${dist}odds/odds-sync.service.js`);
const { AuditService } = require(`${dist}audit/audit.service.js`);
const { HierarchyService } = require(`${dist}users/hierarchy.service.js`);
const { UsersService } = require(`${dist}users/users.service.js`);

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] && !args[at + 1].startsWith("--") ? args[at + 1] : fallback;
};
const apply = args.includes("--apply");
const username = option("player", "player_001");
const yesterday = new Date();
yesterday.setUTCDate(yesterday.getUTCDate() - 1);
yesterday.setUTCHours(0, 0, 0, 0);
const since = new Date(option("since", yesterday.toISOString()));
if (Number.isNaN(since.getTime())) throw new Error("--since isn't a date");

const prisma = new PrismaClient();
const iso = (date) => (date ? new Date(date).toISOString().replace(".000Z", "Z") : "—");
const money = (value) => `${Number(value).toFixed(2)} ALL`;

async function main() {
  const player = await prisma.user.findFirst({ where: { username, role: "PLAYER" }, select: { id: true, username: true } });
  if (!player) throw new Error(`No Player called ${username}`);
  const onLive = { live: { not: Prisma.DbNull } };
  const bets = await prisma.bet.findMany({
    where: { playerId: player.id, placedAt: { gte: since }, OR: [{ live: { not: Prisma.DbNull } }, { legs: { some: { live: { not: Prisma.DbNull } } } }] },
    orderBy: { placedAt: "asc" },
    select: {
      id: true, kind: true, stake: true, odds: true, payout: true, status: true, voidReason: true, placedAt: true, settledAt: true, description: true, live: true,
      selection: { select: { name: true, market: { select: { key: true, name: true, eventId: true } } } },
      legs: { where: onLive, select: { id: true, result: true, voidReason: true, live: true, selection: { select: { name: true, market: { select: { key: true, name: true, eventId: true } } } } } },
    },
  });
  // Each live pick: a single, or an accumulator's live leg.
  const picks = bets.flatMap((bet) =>
    bet.selection && bet.live
      ? [{ bet, legId: null, live: bet.live, pick: bet.selection, outcome: bet.status, voidReason: bet.voidReason }]
      : bet.legs.map((leg) => ({ bet, legId: leg.id, live: leg.live, pick: leg.selection, outcome: leg.result ?? "OPEN", voidReason: leg.voidReason })),
  );
  const eventIds = [...new Set(picks.map((p) => p.pick.market.eventId))];

  // Timelines the feed never sent for finished matches: asked for once more, when the feed can be reached.
  const sync = new OddsSyncService(prisma);
  const missing = await prisma.event.findMany({ where: { id: { in: eventIds }, status: "COMPLETED", lateCheck: { equals: Prisma.DbNull } }, select: { id: true } });
  if (missing.length > 0 && sync.mode === "api-football") {
    const found = await sync.refreshLateChecks(missing.map((e) => e.id)).catch((error) => (console.log(`(couldn't fetch timelines: ${error.message})`), 0));
    console.log(`Fetched ${found} of ${missing.length} missing timeline(s) from the feed.`);
  }

  const events = new Map(
    (await prisma.event.findMany({
      where: { id: { in: eventIds } },
      select: { id: true, name: true, league: true, provider: true, externalId: true, status: true, startsAt: true, finishedAt: true, resultHome: true, resultAway: true, lateCheck: true, lateCheckedAt: true, goalsSeen: { orderBy: { seenAt: "asc" } } },
    })).map((e) => [e.id, e]),
  );

  console.log(`Live bets by ${player.username} placed since ${iso(since)}: ${picks.length}. Late rule version ${LATE_RULE_VERSION}.\n`);
  const plan = [];
  for (const { bet, legId, live, pick, outcome, voidReason } of picks) {
    const event = events.get(pick.market.eventId);
    const state = liveStateOf(live);
    const audit = state?.audit;
    const timeline = timelineOf(event.lateCheck);
    const seen = event.goalsSeen.map((row) => ({ home: row.homeScore, away: row.awayScore, seenAt: row.seenAt }));
    const result = event.resultHome !== null && event.resultAway !== null ? { home: event.resultHome, away: event.resultAway } : null;
    console.log(`── ${bet.id}${legId ? ` (accumulator pick ${legId})` : ""}: ${event.name} · ${pick.market.name}: ${pick.name} @ ${bet.odds ?? "SP"}, stake ${money(bet.stake)}`);
    console.log(`   now: ${outcome}${voidReason ? ` (${voidReason})` : ""}, paid ${money(bet.payout)}, settled ${iso(bet.settledAt)}`);
    console.log(`   match: ${event.provider} ${event.externalId ?? "—"}, ${event.league}, ${event.status}, ended ${result ? `${result.home}–${result.away}` : "—"} at ${iso(event.finishedAt)}`);
    console.log(`   placed (server) ${iso(bet.placedAt)}; asked ${iso(audit?.submittedAt)}, confirmed ${iso(audit?.confirmedAt)} after a ${audit?.delayMs ?? "?"} ms wait`);
    console.log(`   site showed ${state ? `${state.home}–${state.away} at ${state.minute ?? "?"}'` : "nothing recorded"}; feed clock ${audit?.clock ?? "—"}; state version ${audit?.versionAtSubmit ?? "—"} → ${audit?.versionAtConfirm ?? "—"}`);
    if (audit?.markAtSubmit || audit?.markAtConfirm) console.log(`   feed read straight: ${audit.markAtSubmit ? `${audit.markAtSubmit.home}–${audit.markAtSubmit.away}, ${audit.markAtSubmit.events} events` : "—"} → ${audit.markAtConfirm ? `${audit.markAtConfirm.home}–${audit.markAtConfirm.away}, ${audit.markAtConfirm.events} events` : "—"}`);
    const clock = kickOffFromClock(audit);
    const kickOffs = timeline ? `first half ${timeline.first ? iso(timeline.first * 1000) : "—"}, second ${timeline.second ? iso(timeline.second * 1000) : "—"}` : "—";
    console.log(`   feed timeline: ${timeline ? `${timeline.goals.length} goal(s), kick-offs ${kickOffs}` : `none (last asked ${iso(event.lateCheckedAt)})`}${clock ? `; kick-off from the bet's clock: ${clock.first ? `first ${iso(clock.first * 1000)}` : `second ${iso(clock.second * 1000)}`}` : ""}`);
    for (const goal of timeline?.goals ?? []) {
      const start = minuteStart(goal, { ...timeline, first: timeline.first ?? clock?.first ?? null, second: timeline.second ?? clock?.second ?? null });
      console.log(`     goal ${goal.side} ${goal.minute}${goal.extra ? `+${goal.extra}` : ""}': its minute began ${start === null ? "— (no kick-off)" : iso(start)}`);
    }
    for (const row of event.goalsSeen) console.log(`     site saw ${row.homeScore}–${row.awayScore} at ${iso(row.seenAt)} (${row.source}${row.lagMs !== null ? `, about ${Math.round(row.lagMs / 1000)} s after it went in, at least ${Math.round(row.lagMinMs / 1000)} s` : ""})`);
    if (event.goalsSeen.length === 0) console.log("     site saw no goal on this match");
    const before = live?.late;
    console.log(`   decided before: ${before ? `${before.late ? "void" : before.undecided ? "can't tell" : "stands"} (${before.when}, ${iso(before.checkedAt)}, rule ${before.version ?? 2}): ${before.reason ?? before.detail}` : "never: the late check didn't run on it (it settled before the check could, or under an older version)"}`);
    if (!state) {
      console.log("   now: can't be checked, no score was recorded when it was placed\n");
      continue;
    }
    let decision = lateDecision({ state, placedAt: bet.placedAt, marketKey: pick.market.key, timeline, seen, result: event.status === "COMPLETED" ? result : null });
    if (decision.undecided && event.status === "COMPLETED") decision = { ...decision, late: true };
    const settled = outcome === "WON" || outcome === "LOST";
    const change = decision.late && settled && !legId ? Number(bet.stake) - Number(bet.payout) : 0;
    console.log(`   rule now: ${decision.late ? `VOID, ${decision.reason}` : decision.undecided ? "can't tell yet (waits for the timeline)" : "stands"}: ${decision.detail}`);
    if (decision.late && settled) console.log(`   → ${apply ? "voiding" : "would void"}${legId ? " this pick (the accumulator is worked out again)" : `, balance ${change >= 0 ? "+" : ""}${money(change)}`}`);
    else if (decision.late && outcome === "OPEN") console.log("   → open: settlement voids it before paying");
    console.log("");
    if (decision.late && settled) plan.push({ bet: bet.id, change });
  }
  const back = plan.reduce((sum, row) => sum + row.change, 0);
  console.log(`${plan.length} settled live bet(s) the rule now voids; balance change ${back >= 0 ? "+" : ""}${money(back)} for ${player.username} (singles).`);

  if (!apply) {
    console.log("Nothing changed: run again with --apply to void them.");
    return;
  }
  const { FieldEncryptionService } = require(`${dist}crypto/field-encryption.service.js`);
  const { NotificationsService } = require(`${dist}notifications/notifications.service.js`);
  const { RealtimeService } = require(`${dist}realtime/realtime.service.js`);
  const realtime = new RealtimeService(prisma);
  const crypto = new FieldEncryptionService({ getOrThrow: (key) => { if (!process.env[key]) throw new Error(`${key} is needed with --apply`); return process.env[key]; } }, prisma);
  const notifications = new NotificationsService(prisma, crypto, realtime);
  const audit = new AuditService(prisma);
  const hierarchy = new HierarchyService(prisma);
  const users = new UsersService(prisma, {}, hierarchy, audit, crypto, notifications, realtime);
  const settlement = new SettlementService(prisma, realtime, notifications, users, audit);
  const admin = await prisma.user.findFirst({ where: { role: "SUPER_ADMIN" }, select: { id: true } });
  const done = await settlement.recheckLate({ playerId: player.id, since, actorId: admin?.id ?? null });
  console.log(`Applied: ${done.checked} settled live bet(s) checked, ${done.voided} voided.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
