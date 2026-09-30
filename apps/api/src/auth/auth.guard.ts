import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Request } from "express";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma.service";
import { clientContext } from "../security/client-context";
import { clientIp } from "../security/client-ip";
import { ThreatIntelService } from "../security/threat-intel.service";
import { parseUserAgent } from "../security/user-agent";
import { bearerToken, ClerkService } from "./clerk.service";
import { Actor, isActive } from "./permissions";

export type AuthenticatedRequest = Request & {
  actor?: Actor;
  clerkUserId?: string;
};

/** A refused account's attempts are recorded at most this often, not on every request its open tabs make. */
const REFUSAL_AUDIT_EVERY_MS = 60 * 60_000;

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly clerk: ClerkService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly threats: ThreatIntelService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = bearerToken(request);
    const ip = clientIp(request) ?? "unknown";

    if (await this.threats.isBlocked(ip)) {
      throw new ForbiddenException("Temporarily blocked due to suspicious activity");
    }

    if (!token) {
      await this.fail(ip, "missing_bearer_token");
      throw new UnauthorizedException("Missing authentication token");
    }

    const verified = await this.clerk.sessionFor(request);
    if (!verified) {
      await this.fail(ip, "invalid_clerk_token");
      throw new UnauthorizedException("Invalid or expired session");
    }
    const { userId: clerkUserId, sessionId } = verified;

    // The three refusals below are someone with a real, signed-in session who
    // isn't allowed in, not someone guessing: their open tabs keep asking every
    // few seconds. So they never count towards a lockout.
    const user = await this.prisma.user.findUnique({ where: { clerkId: clerkUserId } });
    if (!user) {
      await this.refuse(ip, null, "no_local_user", clerkUserId);
      throw new UnauthorizedException("Account is not provisioned in this application");
    }

    if (!isActive(user)) {
      await this.refuse(ip, user.id, "suspended", clerkUserId);
      throw new ForbiddenException("Account is suspended");
    }

    // Suspension cascades down the hierarchy: when an Owner or Manager is
    // suspended, everyone under them is locked out too, without having to
    // flip each downline row (so reactivating the parent restores them all).
    if (user.parentId && (await this.hasSuspendedAncestor(user.id))) {
      await this.refuse(ip, user.id, "ancestor_suspended", clerkUserId);
      throw new ForbiddenException("Account is suspended because an account above it is suspended");
    }

    await this.threats.clearFailures(ip);
    if (sessionId) await this.recordVisit(request, sessionId, user.id, ip);
    request.clerkUserId = clerkUserId;
    request.actor = user;
    return true;
  }

  private async hasSuspendedAncestor(userId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ blocked: boolean }[]>`
      WITH RECURSIVE ancestors AS (
        SELECT parent_id FROM users WHERE id = ${userId}
        UNION ALL
        SELECT u.parent_id FROM users u
        INNER JOIN ancestors a ON u.id = a.parent_id
      )
      SELECT EXISTS(
        SELECT 1 FROM users u
        INNER JOIN ancestors a ON u.id = a.parent_id
        WHERE u.status = 'SUSPENDED'
      ) AS blocked
    `;
    return Boolean(rows[0]?.blocked);
  }

  /** A request with no valid session: counts towards locking out the visitor's address. */
  private async fail(ip: string, reason: string) {
    const result = await this.threats.recordFailure(ip);
    await this.audit.log({
      action: "auth.failure",
      ipAddress: ip,
      metadata: { reason, banned: result.banned, failures: result.failures },
    });
    if (result.banned) {
      await this.threats.ban(ip, reason);
    }
  }

  /**
   * A signed-in account that isn't allowed in (suspended, or not set up here).
   * Recorded once an hour per account, never counted as a failed sign-in.
   */
  private async refuse(ip: string, userId: string | null, reason: string, clerkUserId: string) {
    if (!(await this.threats.firstInWindow(`auth-refused:${clerkUserId}:${reason}`, REFUSAL_AUDIT_EVERY_MS))) return;
    await this.audit.log({
      actorId: userId,
      action: "auth.refused",
      targetId: userId,
      ipAddress: ip,
      metadata: { reason, ...(userId ? {} : { clerkUserId }) },
    });
  }

  /**
   * Keeps the sign-in history for this session current. Only a visit from a
   * browser (signed through our web app, or a browser calling directly)
   * updates where and on what it was; our web server's own calls ("node")
   * just mark the session as seen, so they never overwrite a real visit.
   */
  private async recordVisit(request: Request, sessionId: string, userId: string, ip: string) {
    const context = clientContext(request);
    const header = request.headers["user-agent"];
    const userAgent = context?.userAgent ?? (typeof header === "string" ? header : null);
    const parsed = parseUserAgent(userAgent);
    const visit = parsed
      ? { ipAddress: ip, userAgent, device: parsed.device, browser: parsed.browser, ...(context ? { location: location(context) } : {}) }
      : null;
    await this.prisma.loginHistory.upsert({
      where: { sessionId },
      create: { sessionId, userId, ipAddress: ip, userAgent, ...visit },
      update: { lastSeenAt: new Date(), ...visit },
    });
  }
}

/** "Tirana, AL": city and ISO country code, which the web app shows as the country's name in the reader's language. */
function location(context: { city: string | null; region: string | null; country: string | null }): string | null {
  const place = context.city ?? context.region;
  if (place && context.country) return `${place}, ${context.country}`;
  return context.country ?? place ?? null;
}
