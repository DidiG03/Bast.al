import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { BalanceTransactionType, BetKind, BetStatus, Prisma, Role } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { Actor } from "../auth/permissions";
import { BettingLimitsService } from "../commissions/betting-limits.service";
import { OddsSyncService } from "../odds/odds-sync.service";
import { OddsService } from "../odds/odds.service";
import { PrismaService } from "../prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { UsersService } from "../users/users.service";
import type { MatchCentre } from "../odds/api-football";
import { RACE_CAP } from "../odds/greyhounds";
import { competitionKey } from "../odds/feed-delay";
import { takenWithoutAsking, wrongWayAfterGoal } from "../odds/live-guard";
import { type FeedMark, LIVE_CORNERS_DELAY_MS, LIVE_CORNERS_MAX_STAKE, type LiveAudit, type LiveState, isCardsMarket, isCornersMarket, newInFeed } from "./late";
import { MAX_BUILDER_ODDS, priceBuilder } from "./builder";
import { combinedOdds, payoutFor } from "./grading";
import { MIN_STAKE } from "./bets.dto";
import { normalSizes, systemLines, systemMaxReturn, systemName } from "./system";
import { RiskService } from "./risk.service";
import { assertOnTeam, type TeamSnapshot } from "./team";

/** A goal or pause this recent on a match makes a live slip on it wait longer (LIVE_BET_EVENTFUL_DELAY_MS). */
const EVENTFUL_MS = 3 * 60_000;
/** A live match whose prices are older than this when the slip comes in waits longer too. */
const SLOW_FEED_MS = 10_000;
/** How long the checks with the feed at the end of a live slip's wait may take before the slip is refused. */
const LIVE_CHECK_TIMEOUT_MS = Number(process.env.LIVE_CHECK_TIMEOUT_MS) || 5_000;
/** The live wait is at least the feed's recent delay on goals (this share of goals within it) plus this margin (liveWait). */
const LIVE_LAG_PERCENTILE = Number(process.env.LIVE_LAG_PERCENTILE) > 0 && Number(process.env.LIVE_LAG_PERCENTILE) < 1 ? Number(process.env.LIVE_LAG_PERCENTILE) : 0.95;
const LIVE_LAG_MARGIN_MS = Number(process.env.LIVE_LAG_MARGIN_MS ?? 2_000);
/** The feed's delay on goals is measured over this many days, from at least this many goals (for one competition, or for all), at most this often. */
const LAG_DAYS = 3;
const LAG_MIN_GOALS = 10;
const LAG_MIN_GOALS_COMPETITION = 5;
const LAG_REFRESH_MS = 5 * 60_000;

/** Resolves as `work` does, or rejects with `late()` after `ms` (0: only if it's already settled). */
function withDeadline<T>(work: Promise<T>, ms: number, late: () => unknown): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(late()), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** The moments in a saved match centre, or null without one. */
const momentsOf = (centre: unknown) => (centre as { moments?: Array<{ kind: string }> } | null)?.moments ?? null;

type SlipBet = { selectionId: string; stake: number; odds: number };
type SlipAccumulator = { legs: Array<{ selectionId: string; odds: number }>; stake: number };
type SlipBuilder = { legs: Array<{ selectionId: string; odds: number }>; stake: number; odds: number };
type SlipSystem = { legs: Array<{ selectionId: string; odds: number }>; sizes: number[]; lineStake: number };
/** What a system bet records about itself (Bet.system). */
type SystemInfo = { name: string; sizes: number[]; lineStake: number; lines: number; maxReturn: number };

/** Highest combined price an accumulator can have. */
export const MAX_ACCUMULATOR_ODDS = 5000;

const PAGE = 50;

/** What a bet looks like to the Player who placed it and to Super Admin. */
/** What a bet shows about its match: the score, the minute, and while it's live or just over, its match centre. */
const EVENT_SELECT = { id: true, name: true, league: true, startsAt: true, status: true, homeScore: true, awayScore: true, resultHome: true, resultAway: true, elapsed: true, period: true, matchCentre: true } satisfies Prisma.EventSelect;

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
  system: true,
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
          market: { select: { name: true, event: { select: EVENT_SELECT } } },
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
          event: { select: EVENT_SELECT },
        },
      },
    },
  },
} satisfies Prisma.BetSelect;

type BetRow = Prisma.BetGetPayload<{ select: typeof betSelect }>;

type EventRow = Prisma.EventGetPayload<{ select: typeof EVENT_SELECT }>;

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
    /** While live: the minute and the phase ("HT", "2H"). */
    elapsed: event.elapsed,
    period: event.period,
    /** Football with a bet on it: the timeline and numbers (MatchCentre in odds/api-football.ts), or null. The team sheets load on their own (/odds/events/:id/centre). */
    centre: withoutLineups(event.matchCentre as MatchCentre | null),
  };
}

function withoutLineups(centre: MatchCentre | null): MatchCentre | null {
  return centre ? { ...centre, lineups: null } : null;
}

export function betView(bet: BetRow) {
  const stake = Number(bet.stake);
  const odds = bet.odds === null ? null : Number(bet.odds);
  const event = bet.selection?.market.event ?? null;
  const system = (bet.system as SystemInfo | null) ?? null;
  return {
    kind: bet.kind,
    /** A system bet's name, line sizes, stake per line, number of lines and most it can return. */
    system,
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
    potentialPayout: system ? system.maxReturn : odds === null ? null : Number(payoutFor(BetStatus.WON, bet.stake, bet.odds!)),
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
  private readonly logger = new Logger(BetsService.name);
  /** The feed's recent delay on goals and when it was worked out (feedLag). */
  private lag: { at: number; stats: Awaited<ReturnType<OddsService["feedLagStats"]>> | null } | null = null;

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
   * Places a slip: any number of singles, plus at most one accumulator, one
   * bet builder and one system bet. Everything goes on or nothing does.
   */
  async place(actor: Actor, input: { bets?: SlipBet[]; accumulator?: SlipAccumulator; builder?: SlipBuilder; system?: SlipSystem; acceptOddsChanges?: boolean }, ipAddress?: string) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players can place bets");
    // Recorded on each bet, so later moves and rate changes never rewrite its commission.
    const team = await this.assertOnTeam(actor);
    const ownerId = team.ownerId;
    const snapshot = { ownerId: team.ownerId, managerId: team.managerId, ownerRate: team.ownerRate, managerRate: team.managerRate };
    const singles = input.bets ?? [];
    const acca = input.accumulator;
    if (singles.length === 0 && !acca && !input.builder && !input.system) throw new BadRequestException("Your slip is empty");

    const ids = [...new Set([...singles.map((bet) => bet.selectionId), ...(acca?.legs.map((leg) => leg.selectionId) ?? []), ...(input.system?.legs.map((leg) => leg.selectionId) ?? [])])];
    const selections = await this.prisma.selection.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, market: { select: { name: true, event: { select: { id: true, name: true } } } } },
    });
    const byId = new Map(selections.map((s) => [s.id, s]));

    const changed: string[] = [];
    /** Live picks whose price isn't the one the slip showed: refused whatever the slip says, so the Player sees the new price first. */
    const liveChanged: string[] = [];
    /** True when a pre-match bet is stored at a price the slip didn't show. A small move is taken; a big one needs the Player to confirm it. */
    let adjusted = false;
    // Every pick's price at once, rather than a round of queries for each.
    const quotes = await this.odds.pricesForPlayer(actor.id, ids);
    /** Checks a pick is still open and at the price the Player saw. */
    const price = async (pick: { selectionId: string; odds: number }) => {
      const selection = byId.get(pick.selectionId);
      const quote = quotes.get(pick.selectionId);
      if (!selection || !quote) throw new BadRequestException("One of the bets on your slip no longer exists. Remove it and try again.");
      const { odds, bettable, live, score, sp, marketKey, margin } = quote;
      if (!bettable) {
        throw new BadRequestException(
          live ? `Live bets on ${selection.market.event.name} are paused right now. Try again in a moment.` : `Bets are closed on ${selection.market.event.name}. Remove it from your slip.`,
        );
      }
      // Before kick-off a tick is taken at the price just found, and a real move is refused unless the Player already chose the
      // new price. Live, a price is only ever taken exactly as the slip showed it: one that moved since may not have the last goal
      // in it yet, up or down, so the slip shows it and the Player places again at it.
      if (!sp && Math.abs(odds - pick.odds) > 0.001) {
        if (live) liveChanged.push(`${selection.name} is now ${odds.toFixed(2)}`);
        else if (input.acceptOddsChanges || takenWithoutAsking(pick.odds, odds)) adjusted = true;
        else changed.push(`${selection.name} is now ${odds.toFixed(2)}`);
      }
      return {
        /** Null for a race pick: it's paid at the starting price. */
        price: sp ? null : new Prisma.Decimal(odds.toFixed(2)),
        /** A race pick: the most it can pay at, and the team's margin to take off the starting price. */
        sp: sp ? { cap: new Prisma.Decimal(RACE_CAP[marketKey] ?? RACE_CAP.race_winner), margin: new Prisma.Decimal(margin.toFixed(2)) } : null,
        live,
        score,
        /** A live pick: what the site showed when it was confirmed (set in confirmLive), kept on the bet for the late check. */
        state: null as LiveState | null,
        marketKey,
        eventName: selection.market.event.name,
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
    let pricedSystem: { stake: Prisma.Decimal; odds: Prisma.Decimal; legs: Priced[]; info: SystemInfo; maxReturn: Prisma.Decimal } | null = null;
    if (input.system) {
      const legs: Priced[] = [];
      for (const leg of input.system.legs) legs.push(await price(leg));
      if (legs.some((leg) => leg.sp !== null)) throw new BadRequestException("Greyhound picks can only be single bets. Take them out of the system.");
      if (new Set(legs.map((leg) => leg.eventId)).size !== legs.length) throw new BadRequestException("A system bet can only have one pick from each match");
      const sizes = normalSizes(legs.length, input.system.sizes);
      if (!sizes) throw new BadRequestException("Choose a system: doubles, trebles or more from your picks");
      const lineStake = new Prisma.Decimal(input.system.lineStake.toFixed(2));
      const lines = systemLines(legs.length, sizes).length;
      const { payout, topOdds } = systemMaxReturn(legs.map((leg) => leg.price!), sizes, lineStake);
      if (topOdds.greaterThan(MAX_ACCUMULATOR_ODDS)) throw new BadRequestException(`A system's biggest line can't have odds of more than ${MAX_ACCUMULATOR_ODDS}. Remove a pick.`);
      const stake = lineStake.mul(lines);
      if (stake.lessThan(MIN_STAKE)) throw new BadRequestException(`A system bet has to cost at least ${MIN_STAKE} ALL in all. Raise the stake per bet.`);
      pricedSystem = {
        stake,
        // The most it returns over the stake, rounded up, for the team's open payouts.
        odds: payout.div(stake).toDecimalPlaces(2, Prisma.Decimal.ROUND_UP),
        legs,
        maxReturn: payout,
        info: { name: systemName(legs.length, sizes), sizes, lineStake: Number(lineStake), lines, maxReturn: Number(payout) },
      };
    }
    let pricedBuilder: (Awaited<ReturnType<BetsService["priceBuilderFor"]>> & { stake: Prisma.Decimal }) | null = null;
    if (input.builder) {
      const quote = await this.priceBuilderFor(actor.id, input.builder.legs.map((leg) => leg.selectionId));
      if (Math.abs(Number(quote.odds) - input.builder.odds) > 0.001) {
        if (input.acceptOddsChanges || takenWithoutAsking(input.builder.odds, Number(quote.odds))) adjusted = true;
        else changed.push(`the bet builder is now ${Number(quote.odds).toFixed(2)}`);
      }
      pricedBuilder = { ...quote, stake: new Prisma.Decimal(input.builder.stake.toFixed(2)) };
    }
    if (liveChanged.length > 0 || (changed.length > 0 && !input.acceptOddsChanges)) {
      throw new ConflictException(`The odds changed: ${[...liveChanged, ...changed].join(", ")}. Check your slip and place it again.`);
    }
    // The corners cap is checked before the wait too, so a slip over it is refused straight away; and again when it's stored.
    const cornerBets = () => [
      ...pricedSingles.map((bet) => ({ stake: bet.stake, picks: [bet] })),
      ...(pricedAcca ? [{ stake: pricedAcca.stake, picks: pricedAcca.legs }] : []),
      ...(pricedSystem ? [{ stake: pricedSystem.stake, picks: pricedSystem.legs }] : []),
    ];
    await this.assertLiveCornersRoom(actor.id, cornerBets(), this.prisma);
    // A live pick is only ever stored at the price it was asked at: any move during the wait refuses the slip.
    await this.confirmLive([...pricedSingles, ...(pricedAcca?.legs ?? []), ...(pricedSystem?.legs ?? [])], actor.id);

    const stakes = [...pricedSingles.map((bet) => bet.stake), ...(pricedAcca ? [pricedAcca.stake] : []), ...(pricedBuilder ? [pricedBuilder.stake] : []), ...(pricedSystem ? [pricedSystem.stake] : [])];
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
    if (pricedBuilder) {
      const payout = payoutFor(BetStatus.WON, pricedBuilder.stake, pricedBuilder.odds);
      for (const leg of pricedBuilder.legs) add(leg.selectionId, payout, leg.label);
    }
    // A system counts at the most it can return on each of its picks, like an accumulator.
    if (pricedSystem) for (const leg of pricedSystem.legs) add(leg.selectionId, payoutFor(BetStatus.WON, pricedSystem.stake, pricedSystem.odds), leg.label);

    // Each match's betting volume, added once the slip is in (addVolumes).
    const volumes = new Map<string, number>();
    const addVolume = (eventId: string, stake: Prisma.Decimal | number) => volumes.set(eventId, (volumes.get(eventId) ?? 0) + Number(stake));
    const created = await this.prisma.$transaction(async (tx) => {
      // One slip at a time per Player, so two slips can't both squeeze under
      // the daily loss limit or spend the same balance. The Owner's payout
      // cap is checked last (below).
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${actor.id} FOR UPDATE`;
      await this.assertLiveCornersRoom(actor.id, cornerBets(), tx);
      let alsoStaking = 0;
      for (const stake of stakes) {
        await this.limits.assertCanPlace(actor.id, Number(stake), alsoStaking, tx);
        alsoStaking += Number(stake);
      }
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
              ...(bet.state ? { live: bet.state } : {}),
              ...snapshot,
            },
            select: betSelect,
          }),
        );
        addVolume(bet.eventId, bet.stake);
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
                create: pricedAcca.legs.map((leg, sortOrder) => ({ selectionId: leg.selectionId, odds: leg.price!, description: leg.description, sortOrder, ...(leg.state ? { live: leg.state } : {}) })),
              },
            },
            select: betSelect,
          }),
        );
        for (const leg of pricedAcca.legs) addVolume(leg.eventId, pricedAcca.stake);
      }
      if (pricedBuilder) {
        rows.push(
          await tx.bet.create({
            data: {
              playerId: actor.id,
              kind: BetKind.BUILDER,
              stake: pricedBuilder.stake,
              odds: pricedBuilder.odds,
              description: `Bet builder · ${pricedBuilder.eventName} · ${pricedBuilder.legs.length} picks`.slice(0, 200),
              ...snapshot,
              legs: {
                create: pricedBuilder.legs.map((leg, sortOrder) => ({ selectionId: leg.selectionId, odds: leg.price, description: leg.description, sortOrder })),
              },
            },
            select: betSelect,
          }),
        );
        addVolume(pricedBuilder.eventId, pricedBuilder.stake);
      }
      if (pricedSystem) {
        const { info } = pricedSystem;
        rows.push(
          await tx.bet.create({
            data: {
              playerId: actor.id,
              kind: BetKind.SYSTEM,
              stake: pricedSystem.stake,
              odds: pricedSystem.odds,
              system: info,
              description: `${info.name} · ${pricedSystem.legs.length} picks · ${info.lines} bets`,
              ...snapshot,
              legs: {
                create: pricedSystem.legs.map((leg, sortOrder) => ({ selectionId: leg.selectionId, odds: leg.price!, description: leg.description, sortOrder, ...(leg.state ? { live: leg.state } : {}) })),
              },
            },
            select: betSelect,
          }),
        );
        for (const leg of pricedSystem.legs) addVolume(leg.eventId, pricedSystem.stake);
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
      // Last, with the slip's bets already written: the payout cap locks only
      // the slip's own outcomes, and only from here to the commit, so slips
      // on other outcomes, or on the same ones a moment later, aren't held up.
      await this.risk.assertUnderCap(tx, ownerId, adding);
      return rows;
    });
    await this.addVolumes(volumes);

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
    // The balance after the slip, so the page's top bar shows it at once without waiting for the live stream.
    const { balance } = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { balance: true } });
    return { bets: created.map(betView), total: Number(total), adjusted, balance: Number(balance) };
  }

  /**
   * Adds a placed slip's stakes to each match's betting volume. It runs after
   * the slip is in, one match at a time and always in the same order: inside
   * the slip's transaction, every bet on a busy match would wait for that
   * match's row, and two accumulators locking the same matches in a
   * different order would deadlock. Volume is only a tally, so a slip never
   * fails over it.
   */
  private async addVolumes(volumes: Map<string, number>) {
    for (const [eventId, amount] of [...volumes].sort(([a], [b]) => a.localeCompare(b))) {
      await this.prisma.event.update({ where: { id: eventId }, data: { volume: { increment: amount } } }).catch(() => undefined);
    }
  }

  /** The bet builder's price for these picks, for the slip while the Player picks them. */
  async quoteBuilder(actor: Actor, selectionIds: string[]) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players can place bets");
    const quote = await this.priceBuilderFor(actor.id, selectionIds);
    return { odds: Number(quote.odds), legs: quote.legs.map((leg) => ({ selectionId: leg.selectionId, odds: Number(leg.price) })) };
  }

  /**
   * Prices a bet builder for a Player (see builder.ts): picks from one
   * football match that hasn't started, one from each market, each at the
   * price the Player's team sees. Refuses picks the builder can't price or
   * that can't all happen together, saying which.
   */
  private async priceBuilderFor(playerId: string, selectionIds: string[]) {
    if (selectionIds.length < 2) throw new BadRequestException("A bet builder needs at least 2 picks");
    if (new Set(selectionIds).size !== selectionIds.length) throw new BadRequestException("The same pick is in your bet builder twice. Remove one.");
    const rows = await this.prisma.selection.findMany({
      where: { id: { in: selectionIds } },
      select: { id: true, key: true, name: true, market: { select: { id: true, key: true, name: true, event: { select: { id: true, name: true, sport: true } } } } },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const picks = selectionIds.map((id) => byId.get(id));
    if (picks.some((pick) => !pick)) throw new BadRequestException("One of the bets on your slip no longer exists. Remove it and try again.");
    const legs = picks as NonNullable<(typeof picks)[number]>[];
    const event = legs[0].market.event;
    if (legs.some((leg) => leg.market.event.id !== event.id)) throw new BadRequestException("A bet builder's picks all have to be from the same match.");
    if (event.sport !== "football") throw new BadRequestException("The bet builder is for football matches.");
    if (new Set(legs.map((leg) => leg.market.id)).size !== legs.length) throw new BadRequestException("Only one pick from each market can go in a bet builder.");

    // The match's result and total goals prices, to fit the builder's goals model to.
    const anchors = await this.prisma.selection.findMany({
      where: { market: { eventId: event.id, key: { in: ["match_winner", "goals_2_5"] } } },
      select: { key: true, feedOdds: true, market: { select: { key: true } } },
    });
    const anchorPrice = (market: string, key: string) => Number(anchors.find((row) => row.market.key === market && row.key === key)?.feedOdds ?? 0);
    const anchor = {
      home: anchorPrice("match_winner", "home"),
      draw: anchorPrice("match_winner", "draw"),
      away: anchorPrice("match_winner", "away"),
      over: anchorPrice("goals_2_5", "over"),
      under: anchorPrice("goals_2_5", "under"),
    };

    const priced = [];
    for (const leg of legs) {
      const now = await this.odds.priceForPlayer(playerId, leg.id);
      if (now.live) throw new BadRequestException(`The bet builder is for matches that haven't started. ${event.name} is live.`);
      if (!now.bettable) throw new BadRequestException(`Bets are closed on ${leg.name} (${event.name}). Remove it from your slip.`);
      priced.push({
        selectionId: leg.id,
        marketKey: leg.market.key,
        selectionKey: leg.key,
        price: new Prisma.Decimal(now.odds.toFixed(2)),
        label: `${leg.name} (${event.name})`,
        description: `${event.name} · ${leg.market.name}: ${leg.name}`.slice(0, 200),
      });
    }
    const quote = priceBuilder(
      priced.map((leg) => ({ marketKey: leg.marketKey, selectionKey: leg.selectionKey, price: Number(leg.price) })),
      anchor,
    );
    if (!quote.ok) {
      const named = quote.leg === undefined ? null : `${legs[quote.leg].market.name}: ${legs[quote.leg].name}`;
      switch (quote.reason) {
        case "unsupported":
          throw new BadRequestException(named ? `${named} can't go in a bet builder. Remove it.` : `The bet builder isn't available for ${event.name}.`);
        case "impossible":
          throw new BadRequestException("These picks can't all happen together. Remove one of them.");
        case "covered":
          throw new BadRequestException(`${named} adds nothing: another pick already includes it. Remove it.`);
        case "too-low":
          throw new BadRequestException("These picks together are too likely to be priced. Change or add a pick.");
        case "too-high":
          throw new BadRequestException(`A bet builder's odds can't be more than ${MAX_BUILDER_ODDS}. Remove a pick.`);
      }
    }
    return { odds: new Prisma.Decimal(quote.odds.toFixed(2)), eventId: event.id, eventName: event.name, legs: priced };
  }

  /**
   * Live picks wait before they're accepted, so nobody can bet on a goal they've
   * seen before the feed has. The wait (liveWait) is LIVE_BET_DELAY_MS (8
   * seconds by default), or LIVE_BET_EVENTFUL_DELAY_MS (12) when the match is
   * busy (see eventfulReason), or longer when the feed has lately been further
   * behind the ground than that; a corners pick waits LIVE_CORNERS_DELAY_MS.
   *
   * When the slip comes in, each live football match is read straight from the
   * feed (its fixture and timeline, FeedMark), and again at the end of the wait
   * together with its live prices; those last checks have LIVE_CHECK_TIMEOUT_MS
   * to answer, or the slip is refused. They start about a second before the
   * wait ends, not at the start: a check at the start would still be the
   * pre-goal price. The slip is refused if, between the two, the feed shows
   * a goal, a red card, a VAR check or a penalty (any card on a cards pick);
   * if the score in either of the feed's sources isn't the one the slip was
   * placed on; if the site saw the match change at all during the wait
   * (Event.liveVersion: a score, a pause, the bookmaker blocking or reopening
   * it); if the market was paused or suspended; if the price moved at all,
   * up or down; or if a match-result price is no shorter for a side that
   * scored in the last minutes than before its goal (wrongWayAfterGoal). A
   * live pick is never stored at a price the slip didn't show. If the feed
   * can't be reached the slip is refused too. The other picks on the
   * slip are checked again after the wait as well, so a match that kicked off
   * (or was suspended) meanwhile isn't bet on at its pre-match price.
   *
   * Each live football match's cards are recorded for the late check; for a
   * cards pick, if they can't be, the slip is refused. Every live pick keeps
   * its timing (LiveAudit) and is logged, confirmed or refused. LIVE_VERIFY=off
   * skips the checks with the feed.
   */
  private async confirmLive(
    picks: Array<{ selectionId: string; eventId: string; live: boolean; score: string; price: Prisma.Decimal | null; label: string; marketKey: string; state: LiveState | null }>,
    playerId: string,
  ): Promise<void> {
    const live = picks.filter((pick) => pick.live);
    if (live.length === 0) return;
    const submittedAt = new Date();
    const liveIds = [...new Set(live.map((pick) => pick.eventId))];
    const checking = process.env.LIVE_VERIFY !== "off";
    // The feed's own record of each match as the slip comes in, read while the slip waits.
    const markingAtSubmit = checking ? this.sync.readMarks(liveIds).catch(() => null) : Promise.resolve(null);
    // What the site had when the slip came in: to tell what changed during the wait, and for the record.
    const atSubmit = new Map(
      (await this.prisma.event.findMany({ where: { id: { in: liveIds } }, select: { id: true, name: true, provider: true, league: true, liveOddsAt: true, liveCooldownUntil: true, matchCentre: true, liveVersion: true } })).map((event) => [event.id, event]),
    );
    const longerBecause = await this.eventfulReason(liveIds, atSubmit, submittedAt);
    const waits = await this.liveWait([...atSubmit.values()]);
    // A competition whose feed is further behind than the longest wait: a wait wouldn't cover it, so no live bets.
    if (waits.tooSlow) {
      this.logger.warn(`Live slip refused for player ${playerId}: the feed for ${waits.tooSlow} is too far behind (${waits.feedLagMs} ms with the margin, ${waits.mostMs} ms the longest wait)`);
      throw new ConflictException(`Live betting on ${waits.tooSlow} is paused: our feed for it is running too far behind. Try a match from another competition.`);
    }
    const usual = longerBecause ? waits.busyMs : waits.usualMs;
    const delay = live.some((pick) => isCornersMarket(pick.marketKey)) ? Math.max(usual, waits.cornersMs) : usual;
    const askedOdds = new Map(live.map((pick) => [pick, pick.price === null ? null : Number(pick.price)]));
    const refuse = (message: string) => {
      this.logger.warn(`Live slip refused for player ${playerId} after ${Date.now() - submittedAt.getTime()} ms (${delay} ms wait${longerBecause ? `, longer: ${longerBecause}` : ""}): ${message}`);
      return new ConflictException(message);
    };
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const lead = Math.min(1_000, Math.max(0, delay));
    if (delay > lead) await wait(delay - lead);
    const onCards = new Set(live.filter((pick) => isCardsMarket(pick.marketKey)).map((pick) => pick.eventId));
    const cardsUnknown = () => refuse("We couldn't confirm the cards shown so far with the feed just now. Try again in a moment.");
    const unconfirmed = () => refuse("We couldn't confirm the live price with the bookmaker just now. Try again in a moment.");
    const checkStarted = Date.now();
    let marksAtConfirm: Map<string, FeedMark> | null = null;
    const verify = checking
      ? withDeadline(
          Promise.all([
            this.sync.verifyLive(liveIds).catch(() => {
              throw unconfirmed();
            }),
            // Every live match's timeline straight from the feed; only a cards pick needs it to go ahead.
            this.sync.readMarks(liveIds).then(
              (marks) => void (marksAtConfirm = marks),
              () => {
                if (onCards.size > 0) throw cardsUnknown();
              },
            ),
          ]),
          lead + LIVE_CHECK_TIMEOUT_MS,
          unconfirmed,
        )
      : null;
    // Handled below; this keeps a check that fails while we wait from counting as unhandled meanwhile.
    verify?.catch(() => undefined);
    if (lead > 0) await wait(lead);
    if (verify) await verify;
    const checkMs = checking ? Date.now() - checkStarted - lead : null;
    // The read from when the slip came in has had the whole wait to answer; one that hasn't by now doesn't count.
    const marksAtSubmit = await withDeadline(markingAtSubmit, 0, () => null).catch(() => null);
    for (const pick of picks.filter((p) => !p.live)) {
      const now = await this.odds.priceForPlayer(playerId, pick.selectionId);
      if (!now.bettable || now.live) throw refuse(`Bets on ${pick.label} closed while your slip was being confirmed. Remove it and try again.`);
    }
    // The minute and the cards shown so far, kept on each live pick with its score for the late check (bets/late.ts).
    const events = await this.prisma.event.findMany({ where: { id: { in: liveIds } }, select: { id: true, elapsed: true, matchCentre: true, liveOddsAt: true, liveVersion: true } });
    const shown = new Map(events.map((event) => [event.id, event]));
    // Goals in the last minutes, with the match-result prices from just before each, for prices that haven't caught up.
    const recentGoals = await this.prisma.goalSeen.findMany({
      where: { eventId: { in: liveIds }, seenAt: { gte: new Date(submittedAt.getTime() - EVENTFUL_MS) }, beforeGoal: { not: Prisma.DbNull } },
      select: { eventId: true, beforeGoal: true },
    });
    const feedPrices = new Map(
      (await this.prisma.selection.findMany({ where: { id: { in: live.map((pick) => pick.selectionId) } }, select: { id: true, key: true, liveOdds: true } })).map((row) => [row.id, row]),
    );
    for (const pick of live) {
      const now = await this.odds.priceForPlayer(playerId, pick.selectionId);
      if (!now.bettable) throw refuse(`Live betting on ${pick.label} was paused while your bet was being confirmed. Try again in a moment.`);
      if (now.score !== pick.score) throw refuse(`The score changed while your bet on ${pick.label} was being confirmed. Check the new odds and try again.`);
      const [home, away] = now.score.split(":").map(Number);
      const markBefore = marksAtSubmit?.get(pick.eventId) ?? null;
      const markAfter = (marksAtConfirm as Map<string, FeedMark> | null)?.get(pick.eventId) ?? null;
      // The feed's fixture can have a goal its prices don't yet.
      if (markAfter && markAfter.home !== null && markAfter.away !== null && (markAfter.home > home || markAfter.away > away)) {
        throw refuse(`The score changed while your bet on ${pick.label} was being confirmed. Check the new odds and try again.`);
      }
      const happened = markBefore && markAfter ? newInFeed(markBefore, markAfter, isCardsMarket(pick.marketKey)) : null;
      if (happened) {
        const what = {
          "a goal": `The score changed while your bet on ${pick.label} was being confirmed.`,
          "a red card": `A red card was shown while your bet on ${pick.label} was being confirmed.`,
          "a VAR check": `There was a VAR check while your bet on ${pick.label} was being confirmed.`,
          "a penalty": `There was a penalty while your bet on ${pick.label} was being confirmed.`,
          "a card": `A card was shown while your bet on ${pick.label} was being confirmed.`,
        }[happened];
        throw refuse(`${what} Check the new odds and try again.`);
      }
      const event = shown.get(pick.eventId);
      // Anything the site saw change in the match during the wait (a score, a pause, the bookmaker blocking or reopening it).
      const versionAtSubmit = atSubmit.get(pick.eventId)?.liveVersion ?? null;
      if (event && versionAtSubmit !== null && event.liveVersion !== versionAtSubmit) {
        throw refuse(`Something happened in the match while your bet on ${pick.label} was being confirmed. Check the new odds and try again.`);
      }
      const moments = momentsOf(event?.matchCentre);
      const redsBefore = momentsOf(atSubmit.get(pick.eventId)?.matchCentre)?.filter((moment) => moment.kind === "red").length;
      const reds = moments ? moments.filter((moment) => moment.kind === "red").length : null;
      // A red card during the wait changes the match as much as a goal.
      if (reds !== null && redsBefore !== undefined && reds > redsBefore) throw refuse(`A red card was shown while your bet on ${pick.label} was being confirmed. Check the new odds and try again.`);
      const feed = feedPrices.get(pick.selectionId);
      for (const goal of recentGoals.filter((row) => row.eventId === pick.eventId)) {
        const before = goal.beforeGoal as { side?: string; home?: number | null; draw?: number | null; away?: number | null } | null;
        const price = feed?.liveOdds === null || feed?.liveOdds === undefined ? null : Number(feed.liveOdds);
        if (!before || (before.side !== "home" && before.side !== "away") || price === null) continue;
        if (wrongWayAfterGoal({ marketKey: pick.marketKey, selectionKey: feed!.key, price, side: before.side, before })) {
          throw refuse(`The odds on ${pick.label} haven't caught up with the last goal yet. Try again in a moment.`);
        }
      }
      // Any move during the wait, up or down, shows the Player the new price first: a price that went up right after a goal is
      // usually one the bookmaker hasn't made for it yet, and the bet is never taken at a price the slip didn't show.
      if (pick.price !== null && Math.abs(now.odds - Number(pick.price)) > 0.001) {
        throw refuse(`The odds changed: ${pick.label} is now ${now.odds.toFixed(2)}. Check your slip and place it again.`);
      }
      const reading = this.sync.liveReading(pick.eventId);
      const audit: LiveAudit = {
        submittedAt: submittedAt.toISOString(),
        confirmedAt: new Date().toISOString(),
        delayMs: delay,
        longerBecause,
        askedOdds: askedOdds.get(pick) ?? null,
        confirmedOdds: pick.price === null ? null : Number(pick.price),
        feedAtSubmit: atSubmit.get(pick.eventId)?.liveOddsAt?.toISOString() ?? null,
        feedAtConfirm: event?.liveOddsAt?.toISOString() ?? null,
        bookmakerUpdate: reading?.bookmakerUpdate ?? null,
        clock: reading?.clock ?? null,
        markAtSubmit: markBefore,
        markAtConfirm: markAfter,
        scoreFromOdds: now.score,
        scoreFromFixture: markAfter && markAfter.home !== null && markAfter.away !== null ? `${markAfter.home}:${markAfter.away}` : null,
        checkMs,
        versionAtSubmit,
        versionAtConfirm: event?.liveVersion ?? null,
      };
      pick.state = Number.isInteger(home) && Number.isInteger(away)
        ? { home, away, minute: event?.elapsed ?? null, cards: moments ? moments.filter((moment) => moment.kind === "yellow" || moment.kind === "red").length : null, reds, audit }
        : null;
      // A cards bet without the cards shown so far couldn't be checked after the match, so it isn't taken.
      if (checking && isCardsMarket(pick.marketKey) && pick.state?.cards == null) throw cardsUnknown();
      // One line per live pick, for checking a case afterwards (the bet keeps the same in live.audit).
      this.logger.log(
        `Live pick confirmed for player ${playerId}: ${pick.label} [${pick.marketKey}] at ${now.score} (fixture ${audit.scoreFromFixture ?? "unknown"}, clock ${audit.clock ?? "unknown"}), asked ${audit.askedOdds ?? "SP"} got ${audit.confirmedOdds ?? "SP"}, ` +
          `submitted ${audit.submittedAt}, confirmed ${audit.confirmedAt}, waited ${delay} ms${longerBecause ? ` (${longerBecause})` : ""}, checks ${checkMs ?? "skipped"} ms, ` +
          `feed read ${audit.feedAtSubmit ?? "never"} then ${audit.feedAtConfirm ?? "never"}, bookmaker update ${audit.bookmakerUpdate ?? "unknown"}, ` +
          `feed events ${markBefore ? `${markBefore.events} (last ${markBefore.last ?? "none"})` : "unknown"} then ${markAfter ? `${markAfter.events} (last ${markAfter.last ?? "none"})` : "unknown"}`,
      );
    }
  }

  /**
   * How long live picks wait (see confirmLive): the usual wait, the wait on a
   * busy match, the wait with a corners pick, and how long the checks with the
   * feed at the end may take on top. The wait is at least the feed's delay on
   * goals (its LIVE_LAG_PERCENTILE, 95th by default, over the last LAG_DAYS
   * days: lagStats) plus LIVE_LAG_MARGIN_MS, for each match's competition when
   * it has LAG_MIN_GOALS_COMPETITION goals measured, otherwise for the whole
   * feed when that has LAG_MIN_GOALS, up to LIVE_BET_MAX_DELAY_MS. When that's
   * more than the longest wait, `tooSlow` names the competition and the slip
   * is refused. LIVE_BET_ADAPTIVE_DELAY=off keeps the waits fixed.
   */
  async liveWait(events: Array<{ name?: string; provider: string; league: string }> = []): Promise<{
    usualMs: number;
    busyMs: number;
    cornersMs: number;
    checkMs: number;
    mostMs: number;
    feedLagMs: number | null;
    tooSlow: string | null;
  }> {
    const base = Number(process.env.LIVE_BET_DELAY_MS ?? 8_000);
    const eventful = Math.max(base, Number(process.env.LIVE_BET_EVENTFUL_DELAY_MS ?? 12_000));
    const most = Math.max(eventful, Number(process.env.LIVE_BET_MAX_DELAY_MS ?? 30_000));
    const stats = await this.feedLag();
    /** The delay to cover for one match's competition (ms), margin included, or null when not enough is measured. */
    const needed = (event: { provider: string; league: string }) => {
      if (!stats) return null;
      const own = stats.byCompetition[competitionKey(event.provider, event.league)];
      const group = own && own.goals >= LAG_MIN_GOALS_COMPETITION ? own : stats.all && stats.all.goals >= LAG_MIN_GOALS ? stats.all : null;
      return group ? group.p * 1000 + LIVE_LAG_MARGIN_MS : null;
    };
    const asked = events.length > 0 ? events : [{ provider: "", league: "" }];
    const lags = asked.map((event) => ({ event, ms: needed(event) }));
    const slowest = lags.reduce<(typeof lags)[number] | null>((top, row) => (row.ms !== null && (top === null || row.ms > (top.ms ?? 0)) ? row : top), null);
    const feedLagMs = slowest?.ms ?? null;
    const tooSlow = slowest && feedLagMs !== null && feedLagMs > most && events.length > 0 ? slowest.event.league : null;
    const usualMs = Math.min(most, Math.max(base, feedLagMs ?? 0));
    const busyMs = Math.min(most, Math.max(eventful, usualMs + (eventful - base)));
    return { usualMs, busyMs, cornersMs: Math.max(busyMs, LIVE_CORNERS_DELAY_MS), checkMs: LIVE_CHECK_TIMEOUT_MS + 1_000, mostMs: most, feedLagMs, tooSlow };
  }

  /** The feed's delay on goals lately (lagStats), worked out at most every LAG_REFRESH_MS; null with LIVE_BET_ADAPTIVE_DELAY=off. */
  private async feedLag(): Promise<Awaited<ReturnType<OddsService["feedLagStats"]>> | null> {
    if (process.env.LIVE_BET_ADAPTIVE_DELAY === "off") return null;
    if (this.lag && Date.now() - this.lag.at < LAG_REFRESH_MS) return this.lag.stats;
    const stats = await this.odds.feedLagStats(LAG_DAYS, LIVE_LAG_PERCENTILE).catch(() => null);
    const all = stats?.all ?? null;
    if (all?.p !== this.lag?.stats?.all?.p) {
      this.logger.log(`Feed delay on goals over the last ${LAG_DAYS} days: ${all ? `${Math.round(LIVE_LAG_PERCENTILE * 100)}% within ${all.p} s, median ${all.median} s, from ${all.goals} goals` : "none measured yet"}`);
      for (const [competition, group] of Object.entries(stats?.byCompetition ?? {})) {
        if (group.goals >= LAG_MIN_GOALS_COMPETITION) this.logger.log(`Feed delay on goals in ${competition}: ${Math.round(LIVE_LAG_PERCENTILE * 100)}% within ${group.p} s, median ${group.median} s, from ${group.goals} goals`);
      }
    }
    this.lag = { at: Date.now(), stats };
    return stats;
  }

  /**
   * Why a live slip waits longer than usual, or null: one of its matches had a
   * goal or a pause in the last few minutes (more may follow, and the feed is
   * often slow just then), or its prices haven't come in for a while.
   */
  private async eventfulReason(eventIds: string[], events: Map<string, { liveOddsAt: Date | null; liveCooldownUntil: Date | null }>, now: Date): Promise<string | null> {
    const recent = new Date(now.getTime() - EVENTFUL_MS);
    if ([...events.values()].some((event) => event.liveCooldownUntil && event.liveCooldownUntil > recent)) return "a pause on the match in the last minutes";
    if ([...events.values()].some((event) => !event.liveOddsAt || now.getTime() - event.liveOddsAt.getTime() > SLOW_FEED_MS)) return "the match's prices are slow to come in";
    const goal = await this.prisma.goalSeen.findFirst({ where: { eventId: { in: eventIds }, seenAt: { gte: recent } }, select: { id: true } });
    return goal ? "a goal in the last minutes" : null;
  }

  /**
   * Refuses a slip that would take a Player's open live corners bets on a
   * match over LIVE_CORNERS_MAX_STAKE (bets/late.ts). An accumulator or system
   * with a live corners pick counts at its whole stake. The check that counts
   * runs inside the slip's transaction, after the Player's row is locked, so
   * two slips can't both squeeze under it.
   */
  private async assertLiveCornersRoom(playerId: string, bets: Array<{ stake: Prisma.Decimal; picks: Array<{ live: boolean; marketKey: string; eventId: string; eventName: string }> }>, tx: Prisma.TransactionClient) {
    const adding = new Map<string, { stake: number; match: string }>();
    for (const bet of bets) {
      for (const pick of bet.picks) {
        if (!pick.live || !isCornersMarket(pick.marketKey)) continue;
        adding.set(pick.eventId, { stake: (adding.get(pick.eventId)?.stake ?? 0) + Number(bet.stake), match: pick.eventName });
      }
    }
    for (const [eventId, { stake, match }] of adding) {
      const onCorners = { market: { eventId, OR: ["corners", "home_corners", "away_corners"].map((prefix) => ({ key: { startsWith: prefix } })) } } satisfies Prisma.SelectionWhereInput;
      const open = await tx.bet.aggregate({
        where: {
          playerId,
          status: BetStatus.OPEN,
          OR: [{ live: { not: Prisma.DbNull }, selection: onCorners }, { legs: { some: { live: { not: Prisma.DbNull }, selection: onCorners } } }],
        },
        _sum: { stake: true },
      });
      const already = Number(open._sum.stake ?? 0);
      if (already + stake > LIVE_CORNERS_MAX_STAKE + 0.001) {
        const left = Math.max(0, LIVE_CORNERS_MAX_STAKE - already);
        throw new BadRequestException(`Live bets on corners are limited to ${LIVE_CORNERS_MAX_STAKE} ALL a match. You can stake ${left.toFixed(2)} ALL more on ${match}.`);
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
    // How long a live bet takes to confirm, for the slip to say: the wait, and the checks with the feed after it.
    const waits = await this.liveWait();
    const seconds = (ms: number) => Math.ceil(ms / 1000);
    const liveWait = { usual: seconds(waits.usualMs), busy: seconds(waits.busyMs), corners: seconds(waits.cornersMs), check: seconds(waits.checkMs) };
    return { balance, maxStake: lower(row?.ownerMaxStake, row?.managerMaxStake), dailyLossLimit, dailyLossUsed, blocked, liveWait };
  }

  /** See assertOnTeam in team.ts. */
  private assertOnTeam(actor: Actor): Promise<TeamSnapshot & { ownerId: string }> {
    return assertOnTeam(this.prisma, actor);
  }
}
