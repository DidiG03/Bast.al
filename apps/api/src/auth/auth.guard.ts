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
import { RealtimeService } from "../realtime/realtime.service";
import { clientContext } from "../security/client-context";
import { clientIp } from "../security/client-ip";
import { ThreatIntelService } from "../security/threat-intel.service";
import { parseUserAgent } from "../security/user-agent";
import { ClerkService } from "./clerk.service";
import { Actor, isActive } from "./permissions";

export type AuthenticatedRequest = Request & {
  actor?: Actor;
  clerkUserId?: string;
};

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly clerk: ClerkService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly threats: ThreatIntelService,
    private readonly realtime: RealtimeService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractBearerToken(request);
    const ip = clientIp(request) ?? "unknown";

    if (await this.threats.isBlocked(ip)) {
      throw new ForbiddenException("Temporarily blocked due to suspicious activity");
    }

    if (!token) {
      await this.fail(ip, null, "missing_bearer_token");
      throw new UnauthorizedException("Missing authentication token");
    }

    let clerkUserId: string;
    let sessionId: string | undefined;
    try {
      const verified = await this.clerk.verifySessionToken(token);
      clerkUserId = verified.userId;
      sessionId = verified.sessionId;
    } catch {
      await this.fail(ip, null, "invalid_clerk_token");
      throw new UnauthorizedException("Invalid or expired session");
    }

    const user = await this.prisma.user.findUnique({ where: { clerkId: clerkUserId } });
    if (!user) {
      await this.fail(ip, null, "no_local_user", { clerkUserId });
      throw new UnauthorizedException("Account is not provisioned in this application");
    }

    if (!isActive(user)) {
      await this.fail(ip, user.id, "suspended");
      throw new ForbiddenException("Account is suspended");
    }

    // Suspension cascades down the hierarchy: when an Owner or Manager is
    // suspended, everyone under them is locked out too, without having to
    // flip each downline row (so reactivating the parent restores them all).
    if (user.parentId && (await this.hasSuspendedAncestor(user.id))) {
      await this.fail(ip, user.id, "ancestor_suspended");
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

  private async fail(
    ip: string,
    actorId: string | null,
    reason: string,
    metadata: Record<string, unknown> = {},
  ) {
    const result = await this.threats.recordFailure(ip);
    await this.audit.log({
      actorId,
      action: "auth.failure",
      ipAddress: ip,
      metadata: { reason, banned: result.banned, failures: result.failures, ...metadata },
    });
    if (actorId) {
      const notification = await this.prisma.notification.create({
        data: {
          userId: actorId,
          type: "SUSPICIOUS_LOGIN",
          title: "Suspicious login activity",
          message: result.banned ? "Your account was temporarily locked after repeated failed sign-in attempts." : "A failed sign-in attempt was detected on your account.",
          metadata: { ipAddress: ip, reason, failures: result.failures },
        },
      });
      await this.realtime.publish(actorId, { type: "notification.created", notification });
    }
    if (result.banned) {
      await this.threats.ban(ip, reason);
    }
  }

  private extractBearerToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    return header.slice("Bearer ".length).trim() || null;
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
