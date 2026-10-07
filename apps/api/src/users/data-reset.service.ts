import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Role } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { ClerkService } from "../auth/clerk.service";
import { Actor } from "../auth/permissions";
import { PrismaService } from "../prisma.service";

/** Clerk sign-ins deleted at once: quick, and well inside Clerk's rate limit. */
const CLERK_CONCURRENCY = 5;
const notSuperAdmin = { role: { not: Role.SUPER_ADMIN } };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Super Admin: clears out test data before real users start. Deletes every
 * Owner, Manager and Player with their Clerk sign-ins, and everything that
 * happened: bets and casino spins, balances and the ledger, commissions,
 * notifications and the audit log. Kept: Super Admin's account and sign-in history, the
 * prices, margins and leagues, the security settings, and the matches from
 * the feed.
 *
 * The sign-ins go first. If Clerk fails part way, nothing in the database
 * has changed yet, and running it again finishes the job (a sign-in that's
 * already gone counts as done). DATA_RESET=off turns it off, for once real
 * users are in.
 */
@Injectable()
export class DataResetService {
  private readonly logger = new Logger(DataResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clerk: ClerkService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  private get enabled(): boolean {
    return this.config.get<string>("DATA_RESET")?.trim().toLowerCase() !== "off";
  }

  /** What a reset would delete right now. */
  async preview(actor: Actor) {
    if (actor.role !== Role.SUPER_ADMIN) throw new ForbiddenException("Only Super Admin can delete all data");
    const [accounts, bets, casinoSpins, ledgerEntries, notifications, auditEntries] = await Promise.all([
      this.prisma.user.count({ where: notSuperAdmin }),
      this.prisma.bet.count(),
      this.prisma.casinoSpin.count(),
      this.prisma.balanceTransaction.count(),
      this.prisma.notification.count(),
      this.prisma.auditLog.count(),
    ]);
    return { enabled: this.enabled, accounts, bets, casinoSpins, ledgerEntries, notifications, auditEntries };
  }

  /** Deletes it all, once Super Admin has typed their own username and their password. */
  async reset(actor: Actor, input: { username: string; password: string }, ipAddress?: string) {
    if (actor.role !== Role.SUPER_ADMIN) throw new ForbiddenException("Only Super Admin can delete all data");
    if (!this.enabled) throw new ForbiddenException("Deleting all data is turned off on this server (DATA_RESET=off).");
    if (input.username.trim().toLowerCase() !== actor.username.toLowerCase()) throw new BadRequestException("Type your own username to confirm.");
    await this.checkPassword(actor, input.password);

    const accounts = await this.prisma.user.findMany({ where: notSuperAdmin, select: { clerkId: true } });
    const failed = await this.deleteSignIns(accounts.map((account) => account.clerkId));
    if (failed > 0) {
      throw new ConflictException(`${failed} of ${accounts.length} sign-ins couldn't be deleted in Clerk, so nothing else was deleted yet. Try again in a minute to finish.`);
    }

    const deleted = await this.prisma.$transaction(
      async (tx) => {
        // Children before what they point at: the database refuses to leave money history pointing at nobody.
        const payouts = await tx.commissionPayout.deleteMany({});
        await tx.settlementEntry.deleteMany({});
        await tx.blackjackHand.deleteMany({});
        await tx.minesRound.deleteMany({});
        await tx.penaltyRound.deleteMany({});
        await tx.casinoBookFeature.deleteMany({});
        const spins = await tx.casinoSpin.deleteMany({});
        const ledger = await tx.balanceTransaction.deleteMany({});
        await tx.betLeg.deleteMany({});
        const bets = await tx.bet.deleteMany({});
        await tx.notification.deleteMany({});
        await tx.auditLog.deleteMany({});
        await tx.idempotencyKey.deleteMany({});
        await tx.oddsOverride.deleteMany({});
        await tx.bettingLimit.deleteMany({});
        // Sign-in history, notification settings and unplayed free spins go with each account.
        await tx.user.updateMany({ where: notSuperAdmin, data: { parentId: null } });
        const users = await tx.user.deleteMany({ where: notSuperAdmin });
        // How much was bet on each match counted the test bets.
        await tx.event.updateMany({ data: { volume: 0 } });
        return { accounts: users.count, bets: bets.count, casinoSpins: spins.count, ledgerEntries: ledger.count, commissionPayouts: payouts.count };
      },
      { timeout: 120_000 },
    );
    await this.audit.log({ actorId: actor.id, action: "data.reset", ipAddress, metadata: { ...deleted, signIns: accounts.length } });
    this.logger.warn(`Super Admin ${actor.username} deleted all data: ${JSON.stringify(deleted)}`);
    return { ...deleted, signIns: accounts.length };
  }

  private async checkPassword(actor: Actor, password: string) {
    try {
      await this.clerk.api.users.verifyPassword({ userId: actor.clerkId, password });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== undefined && status >= 400 && status < 500) throw new BadRequestException("That password isn't right.");
      throw new ServiceUnavailableException("Couldn't check your password with Clerk. Try again in a minute.");
    }
  }

  /** Deletes these Clerk users, a few at a time. Returns how many couldn't be deleted. */
  private async deleteSignIns(clerkIds: string[]): Promise<number> {
    const queue = [...clerkIds];
    let failed = 0;
    const worker = async () => {
      for (let clerkId = queue.shift(); clerkId; clerkId = queue.shift()) {
        await this.deleteSignIn(clerkId).catch((error: unknown) => {
          failed += 1;
          this.logger.warn(`Couldn't delete Clerk user ${clerkId}: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    };
    await Promise.all(Array.from({ length: CLERK_CONCURRENCY }, worker));
    return failed;
  }

  /** One Clerk user. Already gone is fine; asked to slow down, it waits and tries again. */
  private async deleteSignIn(clerkId: string) {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.clerk.deleteUserStrict(clerkId);
        return;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 404) return;
        if (status === 429 && attempt <= 3) {
          await sleep(1_000 * attempt);
          continue;
        }
        throw error;
      }
    }
  }
}
