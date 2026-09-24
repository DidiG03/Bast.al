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
import { ThreatIntelService } from "../security/threat-intel.service";
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
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractBearerToken(request);
    const ip = this.clientIp(request) ?? "unknown";

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

    await this.threats.clearFailures(ip);
    if (sessionId) {
      const userAgent = request.headers["user-agent"] ?? null;
      const parsed = this.parseUserAgent(typeof userAgent === "string" ? userAgent : null);
      await this.prisma.loginHistory.upsert({
        where: { sessionId },
        create: { sessionId, userId: user.id, ipAddress: ip, userAgent, device: parsed.device, browser: parsed.browser, location: this.location(request), },
        update: { lastSeenAt: new Date(), ipAddress: ip, userAgent, device: parsed.device, browser: parsed.browser, location: this.location(request) },
      });
    }
    request.clerkUserId = clerkUserId;
    request.actor = user;
    return true;
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
      await this.prisma.notification.create({
        data: {
          userId: actorId,
          type: "SUSPICIOUS_LOGIN",
          title: "Suspicious login activity",
          message: result.banned ? "Your account was temporarily locked after repeated failed sign-in attempts." : "A failed sign-in attempt was detected on your account.",
          metadata: { ipAddress: ip, reason, failures: result.failures },
        },
      });
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

  private clientIp(request: Request): string | undefined {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length > 0) {
      return forwarded.split(",")[0]?.trim();
    }
    return request.ip;
  }

  private location(request: Request): string | null {
    const value = request.headers["x-vercel-ip-country"] ?? request.headers["cf-ipcountry"];
    return typeof value === "string" ? value : null;
  }

  private parseUserAgent(userAgent: string | null) {
    if (!userAgent) return { device: "Unknown device", browser: "Unknown browser" };
    const device = /Mobile|Android|iPhone|iPad/i.test(userAgent) ? "Mobile device" : "Desktop";
    const browser = /Edg\//i.test(userAgent) ? "Edge" : /Chrome\//i.test(userAgent) ? "Chrome" : /Firefox\//i.test(userAgent) ? "Firefox" : /Safari\//i.test(userAgent) ? "Safari" : "Unknown browser";
    return { device, browser };
  }
}
