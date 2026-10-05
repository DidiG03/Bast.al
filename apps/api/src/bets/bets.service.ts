import { BadRequestException, ConflictException, ForbiddenException, Injectable } from "@nestjs/common";
import { BalanceTransactionType, BetKind, BetStatus, Prisma, Role } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { Actor } from "../auth/permissions";
import { BettingLimitsService } from "../commissions/betting-limits.service";
import { OddsSyncService } from "../odds/odds-sync.service";
import { OddsService } from "../odds/odds.service";
import { PrismaService } from "../prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { UsersService } from "../users/users.service";
import { RACE_CAP } from "../odds/greyhounds";
import { combinedOdds, payoutFor } from "./grading";
import { RiskService } from "./risk.service";
import { assertOnTeam, type TeamSnapshot } from "./team";

type SlipBet = { selectionId: string; stake: number; odds: number };
type SlipAccumulator = { legs: Array<{ selectionId: string; odds: number }>; stake: number };

/** Highest combined price an accumulator can have. */
export const MAX_ACCUMULATOR_ODDS = 5000;

const PAGE = 50;

/** What a bet looks like to the Player who placed it and to Super Admin. */
export const betSelect = {
  id: true,
  stake: true,
  odds: true,
  spCap: true,
  payout: true,
  status: true,
  description: true,
  placedAt: true,
  settledAt: true,
  voidReason: true,
  kind: true,
  legs: {
    orderBy: { sortOrder: "asc" },
    select: {
      odds: true,
      result: true,
      description: true,
      voidReason: true,
      selection: {
        select: {
          name: true,
          market: { select: { name: true, event: { select: { id: true, name: true, league: true, startsAt: true, status: true, homeScore: true, awayScore: true, resultHome: true, resultAway: true } } } },
        },
      },
    },
  },
  selection: {
    select: {
      name: true,
      result: true,
      market: {
        select: {
          name: true,
          event: { select: { id: true, name: true, league: true, startsAt: true, status: true, homeScore: true, awayScore: true, resultHome: true, resultAway: true } },
        },
      },
    },
  },
} satisfies Prisma.BetSelect;

type BetRow = Prisma.BetGetPayload<{ select: typeof betSelect }>;

type EventRow = { id: string; name: string; league: string; startsAt: Date; status: string; homeScore: number | null; awayScore: number | null; resultHome: number | null; resultAway: number | null };

function eventView(event: EventRow) {
  return {
    id: event.id,
    name: event.name,
    league: event.league,
    startsAt: event.startsAt,
    status: event.status,
    homeScore: event.homeScore,
    awayScore: event.awayScore,
    result: event.resultHome === null || event.resultAway === null ? null : { home: event.resultHome, away: event.resultAway },
  };
}

export function betView(bet: BetRow) {
  const stake = Number(bet.stake);
  const odds = bet.odds === null ? null : Number(bet.odds);
  const event = bet.selection?.market.event ?? null;
  return {
    kind: bet.kind,
    legs: bet.legs.map((leg) => ({
      name: leg.selection.name,
      market: leg.selection.market.name,
      odds: Number(leg.odds),
      result: leg.result,
      voidReason: leg.voidReason,
      event: eventView(leg.selection.market.event),
    })),
    id: bet.id,
    description: bet.description,
    stake,
    odds,
    /** Greyhounds: paid at the starting price (or forecast dividend), up to `spCap`; `odds` is set when it settles. */
    sp: bet.spCap !== null,
    spCap: bet.spCap === null ? null : Number(bet.spCap),
    /** What a win pays back, stake included. */
    potentialPayout: odds === null ? null : Number(payoutFor(BetStatus.WON, bet.stake, bet.odds!)),
    payout: Number(bet.payout),
    status: bet.status,
    placedAt: bet.placedAt,
    settledAt: bet.settledAt,
    voidReason: bet.voidReason,
    selection: bet.selection ? { name: bet.selection.name, market: bet.selection.market.name } : null,
    event: event ? eventView(event) : null,
  };
}

/**
 * Players placing and viewing their own bets. Prices come from their
 * Owner's odds (OddsService.priceForPlayer) and are locked into the bet;
 * the stake leaves the Player's balance when the bet is placed, and
 * SettlementService pays winnings and refunds back into it.
 */
@Injectable()
export class BetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly odds: OddsService,
    private readonly limits: BettingLimitsService,
    private readonly realtime: RealtimeService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly risk: RiskService,
    private readonly sync: OddsSyncService,
  ) {}

  /**
   * Places a slip: any number of singles, plus at most one accumulator.
   * Everything goes on or nothing does.
   */
  async place(actor: Actor, input: { bets?: SlipBet[]; accumulator?: SlipAccumulator; acceptOddsChanges?: boolean }, ipAddress?: string) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players can place bets");
    // Recorded on each bet, so later moves and rate changes never rewrite its commission.
    const team = await this.assertOnTeam(actor);
    const ownerId = team.ownerId;
    const snapshot = { ownerId: team.ownerId, managerId: team.managerId, ownerRate: team.ownerRate, managerRate: team.managerRate };
    const singles = input.bets ?? [];
    const acca = input.accumulator;
    if (singles.length === 0 && !acca) throw new BadRequestException("Your slip is empty");

    const ids = [...new Set([...singles.map((bet) => bet.selectionId), ...(acca?.legs.map((leg) => leg.selectionId) ?? [])])];
    const selections = await this.prisma.selection.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, market: { select: { name: true, event: { select: { id: true, name: true } } } } },
    });
    const byId = new Map(selections.map((s) => [s.id, s]));

    const changed: string[] = [];
    /** Checks a pick is still open and at the price the Player saw. */
    const price = async (pick: { selectionId: string; odds: number }) => {
      const selection = byId.get(pick.selectionId);
      if (!selection) throw new BadRequestException("One of the bets on your slip no longer exists. Remove it and try again.");
      const { odds, bettable, live, score, sp, marketKey, margin } = await this.odds.priceForPlayer(actor.id, pick.selectionId);
      if (!bettable) {
        throw new BadRequestException(
          live ? `Live bets on ${selection.market.event.name} are paused right now. Try again in a moment.` : `Bets are closed on ${selection.market.event.name}. Remove it from your slip.`,
        );
      }
      if (!sp && Math.abs(odds - pick.odds) > 0.001) changed.push(`${selection.name} is now ${odds.toFixed(2)}`);
      return {
        /** Null for a race pick: it's paid at the starting price. */
        price: sp ? null : new Prisma.Decimal(odds.toFixed(2)),
        /** A race pick: the most it can pay at, and the team's margin to take off the starting price. */
        sp: sp ? { cap: new Prisma.Decimal(RACE_CAP[marketKey] ?? RACE_CAP.race_winner), margin: new Prisma.Decimal(margin.toFixed(2)) } : null,
        live,
        score,
        selectionId: pick.selectionId,
        eventId: selection.market.event.id,
        label: `${selection.name} (${selection.market.event.name})`,
        description: `${selection.market.event.name} · ${selection.market.name}: ${selection.name}${sp ? " (SP)" : ""}`.slice(0, 200),
      };
    };

    type Priced = Awaited<ReturnType<typeof price>>;
    const pricedSingles: Array<Priced & { stake: Prisma.Decimal }> = [];
    for (const bet of singles) pricedSingles.push({ stake: new Prisma.Decimal(bet.stake.toFixed(2)), ...(await price(bet)) });

    let pricedAcca: { stake: Prisma.Decimal; odds: Prisma.Decimal; legs: Priced[] } | null = null;
    if (acca) {
      const legs: Priced[] = [];
      for (const leg of acca.legs) legs.push(await price(leg));
      // A race pick has no price until the off, so an accumulator can't be priced with one in it.
      if (legs.some((leg) => leg.sp !== null)) throw new BadRequestException("Greyhound picks can only be single bets. Take them out of the accumulator.");
      if (new Set(legs.map((leg) => leg.eventId)).size !== legs.length) {
        throw new BadRequestException("An accumulator can only have one pick from each match");
      }
      const odds = combinedOdds(legs.map((leg) => leg.price!));
      if (odds.greaterThan(MAX_ACCUMULATOR_ODDS)) throw new BadRequestException(`An accumulator's combined odds can't be more than ${MAX_ACCUMULATOR_ODDS}. Remove a pick.`);
      pricedAcca = { stake: new Prisma.Decimal(acca.stake.toFixed(2)), odds, legs };
    }
    if (changed.length > 0 && !input.acceptOddsChanges) {
      throw new ConflictException(`The odds changed: ${changed.join(", ")}. Check your slip and place it again.`);
    }
    await this.confirmLive([...pricedSingles, ...(pricedAcca?.legs ?? [])], actor.id);

    const stakes = [...pricedSingles.map((bet) => bet.stake), ...(pricedAcca ? [pricedAcca.stake] : [])];
    const total = stakes.reduce((sum, stake) => sum.add(stake), new Prisma.Decimal(0));

    // What each outcome would add to the team's open payouts, for the Owner's cap.
    const adding = new Map<string, { payout: number; label: string }>();
    const add = (selectionId: string, payout: Prisma.Decimal, label: string) => {
      const prev = adding.get(selectionId);
      adding.set(selectionId, { payout: (prev?.payout ?? 0) + Number(payout), label });
    };
    // A race pick counts at its cap until it's settled.
    for (const bet of pricedSingles) add(bet.selectionId, payoutFor(BetStatus.WON, bet.stake, bet.price ?? bet.sp!.cap), bet.label);
    if (pricedAcca) {
      const payout = payoutFor(BetStatus.WON, pricedAcca.stake, pricedAcca.odds);
      for (const leg of pricedAcca.legs) add(leg.selectionId, payout, leg.label);
    }

    const created = await this.prisma.$transaction(async (tx) => {
      // One slip at a time per Player, so two slips can't both squeeze under
      // the daily loss limit or spend the same balance; and one at a time per
      // team, so two Players can't both squeeze under the Owner's payout cap.
      await this.risk.lockTeam(tx, ownerId);
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${actor.id} FOR UPDATE`;
      let alsoStaking = 0;
      for (const stake of stakes) {
        await this.limits.assertCanPlace(actor.id, Number(stake), alsoStaking);
        alsoStaking += Number(stake);
      }
      await this.risk.assertUnderCap(tx, ownerId, adding);
      const taken = await tx.user.updateMany({ where: { id: actor.id, balance: { gte: total } }, data: { balance: { decrement: total } } });
      if (taken.count === 0) throw new BadRequestException("Your balance is too low for this slip. Ask your Manager for a top-up.");
      const rows = [];
      for (const bet of pricedSingles) {
        rows.push(
          await tx.bet.create({
            data: {
              playerId: actor.id,
              selectionId: bet.selectionId,
              stake: bet.stake,
              odds: bet.price,
              spCap: bet.sp?.cap ?? null,
              spMargin: bet.sp?.margin ?? null,
              description: bet.description,
              ...snapshot,
            },
            select: betSelect,
          }),
        );
        await tx.event.update({ where: { id: bet.eventId }, data: { volume: { increment: bet.stake } } });
      }
      if (pricedAcca) {
        rows.push(
          await tx.bet.create({
            data: {
              playerId: actor.id,
              kind: BetKind.ACCUMULATOR,
              stake: pricedAcca.stake,
              odds: pricedAcca.odds,
              description: `Accumulator · ${pricedAcca.legs.length} picks`,
              ...snapshot,
              legs: {
                create: pricedAcca.legs.map((leg, sortOrder) => ({ selectionId: leg.selectionId, odds: leg.price!, description: leg.description, sortOrder })),
              },
            },
            select: betSelect,
          }),
        );
        for (const leg of pricedAcca.legs) await tx.event.update({ where: { id: leg.eventId }, data: { volume: { increment: pricedAcca.stake } } });
      }
      // Every stake in the Player's balance ledger, so their statement adds up to their balance.
      await tx.balanceTransaction.createMany({
        data: rows.map((bet) => ({
          toUserId: actor.id,
          actorId: actor.id,
          type: BalanceTransactionType.BET_STAKE,
          amount: bet.stake.negated(),
          reason: `Bet placed: ${bet.description ?? "bet"}`,
          betId: bet.id,
        })),
      });
      return rows;
    });

    await this.audit.log({
      actorId: actor.id,
      action: "bet.place",
      targetId: actor.id,
      ipAddress,
      metadata: { bets: created.map((bet) => ({ id: bet.id, kind: bet.kind, stake: Number(bet.stake), odds: bet.odds === null ? "SP" : Number(bet.odds) })), total: Number(total) },
    });
    await this.realtime.publishBalances([actor.id]);
    await this.realtime.publish(actor.id, { type: "bets.changed" });
    await this.users.alertLowBalance(actor.id, Number(total));
    return { bets: created.map(betView), total: Number(total) };
  }

  /**
   * Live picks wait LIVE_BET_DELAY_MS (5 seconds by default) before they're
   * accepted, so nobody can bet on a goal they've seen before the feed has.
   * Then each live match is checked with the feed itself (not our last copy,
   * which can be a few seconds old): if the bookmaker has it blocked, a goal
   * went in, or the price moved, the slip is refused and the Player sees the
   * new price. If the feed can't be reached the slip is refused too.
   * The other picks on the slip are checked again after the wait as well, so
   * a match that kicked off (or was suspended) meanwhile isn't bet on at its
   * pre-match price. LIVE_VERIFY=off skips the check with the feed.
   */
  private async confirmLive(picks: Array<{ selectionId: string; eventId: string; live: boolean; score: string; price: Prisma.Decimal | null; label: string }>, playerId: string) {
    const live = picks.filter((pick) => pick.live);
    if (live.length === 0) return;
    const delay = Number(process.env.LIVE_BET_DELAY_MS ?? 5_000);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (process.env.LIVE_VERIFY !== "off") {
      try {
        await this.sync.verifyLive(live.map((pick) => pick.eventId));
      } catch {
        throw new ConflictException("We couldn't confirm the live price with the bookmaker just now. Try again in a moment.");
      }
    }
    for (const pick of picks.filter((p) => !p.live)) {
      const now = await this.odds.priceForPlayer(playerId, pick.selectionId);
      if (!now.bettable || now.live) throw new ConflictException(`Bets on ${pick.label} closed while your slip was being confirmed. Remove it and try again.`);
    }
    for (const pick of live) {
      const now = await this.odds.priceForPlayer(playerId, pick.selectionId);
      if (!now.bettable) throw new ConflictException(`Live betting on ${pick.label} was paused while your bet was being confirmed. Try again in a moment.`);
      if (now.score !== pick.score) throw new ConflictException(`The score changed while your bet on ${pick.label} was being confirmed. Check the new odds and try again.`);
      if (Math.abs(now.odds - Number(pick.price)) > 0.001) {
        throw new ConflictException(`The odds changed: ${pick.label} is now ${now.odds.toFixed(2)}. Check your slip and place it again.`);
      }
    }
  }

  /** The Player's own bets: open ones, or settled ones newest first. */
  async mine(actor: Actor, status: "open" | "settled" = "open", before?: string) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players have bets");
    const where: Prisma.BetWhereInput = { playerId: actor.id, status: status === "open" ? BetStatus.OPEN : { not: BetStatus.OPEN } };
    const beforeDate = before ? new Date(before) : null;
    if (beforeDate && !Number.isNaN(beforeDate.getTime())) where[status === "open" ? "placedAt" : "settledAt"] = { lt: beforeDate };
    const weekAgo = new Date(Date.now() - 7 * 24 * 3_600_000);
    const [bets, open, week, player] = await Promise.all([
      this.prisma.bet.findMany({ where, orderBy: status === "open" ? { placedAt: "desc" } : { settledAt: "desc" }, take: PAGE, select: betSelect }),
      this.prisma.bet.aggregate({ where: { playerId: actor.id, status: BetStatus.OPEN }, _sum: { stake: true }, _count: { _all: true } }),
      this.prisma.bet.aggregate({ where: { playerId: actor.id, status: { not: BetStatus.OPEN }, settledAt: { gte: weekAgo } }, _sum: { stake: true, payout: true }, _count: { _all: true } }),
      this.prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { balance: true } }),
    ]);
    return {
      balance: Number(player.balance),
      open: { count: open._count._all, staked: Number(open._sum.stake ?? 0) },
      // Bets settled in the last 7 days: what went on them and what came back.
      week: { count: week._count._all, staked: Number(week._sum.stake ?? 0), returned: Number(week._sum.payout ?? 0) },
      bets: bets.map(betView),
      hasMore: bets.length === PAGE,
    };
  }

  /** What a Player may stake: their limits, and whether their account can bet at all. */
  async slipInfo(actor: Actor) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players have a bet slip");
    const row = await this.prisma.bettingLimit.findUnique({ where: { playerId: actor.id } });
    const lower = (a: Prisma.Decimal | null | undefined, b: Prisma.Decimal | null | undefined) => {
      const values = [a, b].filter((v): v is Prisma.Decimal => v !== null && v !== undefined).map(Number);
      return values.length ? Math.min(...values) : null;
    };
    let blocked: string | null = null;
    try {
      await this.assertOnTeam(actor);
    } catch (error) {
      blocked = error instanceof Error ? error.message : "Your account can't bet right now";
    }
    const balance = Number((await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { balance: true } })).balance);
    const dailyLossLimit = lower(row?.ownerDailyLossLimit, row?.managerDailyLossLimit);
    const dailyLossUsed = dailyLossLimit === null ? 0 : await this.limits.usedToday(actor.id);
    return { balance, maxStake: lower(row?.ownerMaxStake, row?.managerMaxStake), dailyLossLimit, dailyLossUsed, blocked };
  }

  /** See assertOnTeam in team.ts. */
  private assertOnTeam(actor: Actor): Promise<TeamSnapshot & { ownerId: string }> {
    return assertOnTeam(this.prisma, actor);
  }
}
