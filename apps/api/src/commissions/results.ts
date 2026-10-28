import { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma.service";

/**
 * What Players staked and were paid in a period, the one way every page
 * counts it (Overview, Finance, a Player's page, Casino, Commissions): from
 * the settlement journal (SettlementEntry), so a bet counts on the day it
 * settled (a correction on the day it was made) and a casino round on the
 * day it was played, split into sports and casino. Periods are Tirana days,
 * weeks and months (time.ts), as the pages pass them.
 *
 * A casino round is one that cost a stake: a spin, a hand, a roll, a
 * ticket. Free spins and double or nothing count in the money (a free spin's
 * win, the gamble's stake and win) but not as rounds.
 */
export type SideResults = { staked: number; paidOut: number; net: number };
export type PeriodResults = {
  sports: SideResults & { bets: number };
  casino: SideResults & { rounds: number };
  total: SideResults;
};

/** Journal rows to count: everyone, one Owner's or Manager's team, or one Player. */
export type ResultsScope = { ownerId?: string; managerId?: string; playerId?: string } | null;

/** The condition on casino_spins (as `c`) for a round that cost a stake. */
export const CASINO_ROUND = Prisma.sql`c.kind <> 'GAMBLE' AND NOT c.free`;

const round = (value: number) => Math.round(value * 100) / 100;

export async function periodResults(prisma: PrismaService, scope: ResultsScope, period: { from: Date | null; to: Date | null }): Promise<PeriodResults> {
  const conditions: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (scope?.ownerId) conditions.push(Prisma.sql`e.owner_id = ${scope.ownerId}`);
  if (scope?.managerId) conditions.push(Prisma.sql`e.manager_id = ${scope.managerId}`);
  if (scope?.playerId) conditions.push(Prisma.sql`e.player_id = ${scope.playerId}`);
  if (period.from) conditions.push(Prisma.sql`e.created_at >= ${period.from}`);
  if (period.to) conditions.push(Prisma.sql`e.created_at < ${period.to}`);
  const [row] = await prisma.$queryRaw<
    Array<{ bets: number; sports_staked: Prisma.Decimal; sports_paid: Prisma.Decimal; rounds: number; casino_staked: Prisma.Decimal; casino_paid: Prisma.Decimal }>
  >`
    SELECT COALESCE(SUM(e.bets), 0)::int AS bets,
           COALESCE(SUM(e.stake) FILTER (WHERE e.casino_spin_id IS NULL), 0) AS sports_staked,
           COALESCE(SUM(e.payout) FILTER (WHERE e.casino_spin_id IS NULL), 0) AS sports_paid,
           (COUNT(*) FILTER (WHERE c.id IS NOT NULL AND ${CASINO_ROUND}))::int AS rounds,
           COALESCE(SUM(e.stake) FILTER (WHERE e.casino_spin_id IS NOT NULL), 0) AS casino_staked,
           COALESCE(SUM(e.payout) FILTER (WHERE e.casino_spin_id IS NOT NULL), 0) AS casino_paid
    FROM settlement_entries e LEFT JOIN casino_spins c ON c.id = e.casino_spin_id
    WHERE ${Prisma.join(conditions, " AND ")}
  `;
  const side = (staked: Prisma.Decimal, paid: Prisma.Decimal): SideResults => ({ staked: round(Number(staked)), paidOut: round(Number(paid)), net: round(Number(staked) - Number(paid)) });
  const sports = side(row.sports_staked, row.sports_paid);
  const casino = side(row.casino_staked, row.casino_paid);
  return {
    sports: { ...sports, bets: Number(row.bets) },
    casino: { ...casino, rounds: Number(row.rounds) },
    total: { staked: round(sports.staked + casino.staked), paidOut: round(sports.paidOut + casino.paidOut), net: round(sports.net + casino.net) },
  };
}
