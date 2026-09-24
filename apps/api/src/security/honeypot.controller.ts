import { Controller, Get, Post, Req } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Request } from "express";
import { AuditService } from "../audit/audit.service";
import { ThreatIntelService } from "./threat-intel.service";

/**
 * Decoy endpoints that real scanners hit. Touching them bans the IP and audits.
 * Responses look boring so bots don't learn the tripwire patterns easily.
 */
@ApiExcludeController()
@Controller()
export class HoneypotController {
  constructor(
    private readonly threats: ThreatIntelService,
    private readonly audit: AuditService,
  ) {}

  @Get(["admin", "wp-admin", "wp-login.php", ".env", "config.json", "phpmyadmin", "actuator/env"])
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async decoyGet(@Req() req: Request) {
    return this.trip(req, "honeypot_get");
  }

  @Post(["admin/login", "api/v1/auth/raw", "graphql"])
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async decoyPost(@Req() req: Request) {
    return this.trip(req, "honeypot_post");
  }

  private async trip(req: Request, action: string) {
    const ip = this.clientIp(req) ?? "unknown";
    await this.threats.ban(ip, action);
    await this.audit.log({
      action: `security.${action}`,
      ipAddress: ip,
      metadata: {
        path: req.originalUrl,
        ua: req.headers["user-agent"] ?? null,
      },
    });
    return { ok: false };
  }

  private clientIp(req: Request): string | undefined {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length > 0) {
      return forwarded.split(",")[0]?.trim();
    }
    return req.ip;
  }
}
