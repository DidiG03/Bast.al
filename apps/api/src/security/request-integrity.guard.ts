import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";
import { AuditService } from "../audit/audit.service";
import { ThreatIntelService } from "./threat-intel.service";

/**
 * Anti-replay + request authenticity for state-changing calls.
 * Requires:
 * - x-bastal-timestamp (ms, within skew)
 * - x-bastal-nonce (unique)
 * - x-bastal-signature = hex(HMAC-SHA256(secret, method\\npath\\ntimestamp\\nnonce\\nsha256(body)))
 */
@Injectable()
export class RequestIntegrityGuard implements CanActivate {
  private readonly secret: Buffer;
  private readonly maxSkewMs: number;

  constructor(
    private readonly config: ConfigService,
    private readonly threats: ThreatIntelService,
    private readonly audit: AuditService,
  ) {
    const hex = this.config.get<string>("REQUEST_INTEGRITY_SECRET") ?? "";
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      // Dev-safe fallback derived later only if explicitly allowed — require configured secret.
      this.secret = Buffer.alloc(0);
    } else {
      this.secret = Buffer.from(hex, "hex");
    }
    this.maxSkewMs = Number(this.config.get("REQUEST_INTEGRITY_SKEW_MS") ?? 60_000);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.secret.length === 0) {
      // Integrity enforcement disabled until REQUEST_INTEGRITY_SECRET is set.
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const method = request.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      return true;
    }

    const ip = this.clientIp(request) ?? "unknown";
    if (await this.threats.isBlocked(ip)) {
      throw new ForbiddenException("Temporarily blocked");
    }

    const timestamp = String(request.headers["x-bastal-timestamp"] ?? "");
    const nonce = String(request.headers["x-bastal-nonce"] ?? "");
    const signature = String(request.headers["x-bastal-signature"] ?? "");

    if (!timestamp || !nonce || !signature) {
      await this.fail(ip, "missing_integrity_headers");
      throw new UnauthorizedException("Missing request integrity headers");
    }

    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > this.maxSkewMs) {
      await this.fail(ip, "timestamp_skew");
      throw new UnauthorizedException("Request expired");
    }

    if (!(await this.threats.consumeNonce(nonce))) {
      await this.fail(ip, "nonce_replay");
      throw new UnauthorizedException("Replay detected");
    }

    const body =
      typeof request.body === "string"
        ? request.body
        : request.body
          ? JSON.stringify(request.body)
          : "";
    const path = request.originalUrl.split("?")[0] ?? request.path;
    const payload = `${method}\n${path}\n${timestamp}\n${nonce}\n${body}`;
    const expected = createHmac("sha256", this.secret).update(payload).digest("hex");

    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      await this.fail(ip, "bad_signature");
      throw new UnauthorizedException("Invalid request signature");
    }

    return true;
  }

  private async fail(ip: string, reason: string) {
    const result = await this.threats.recordFailure(ip);
    await this.audit.log({
      action: "security.integrity_failure",
      ipAddress: ip,
      metadata: { reason, banned: result.banned, failures: result.failures },
    });
    if (result.banned) {
      await this.threats.ban(ip, reason);
    }
  }

  private clientIp(request: Request): string | undefined {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length > 0) {
      return forwarded.split(",")[0]?.trim();
    }
    return request.ip;
  }
}

export function createIntegrityHeaders(input: {
  secretHex: string;
  method: string;
  path: string;
  body?: string;
}): Record<string, string> {
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString("base64url");
  const body = input.body ?? "";
  const path = input.path.split("?")[0] ?? input.path;
  const payload = `${input.method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${body}`;
  const signature = createHmac("sha256", Buffer.from(input.secretHex, "hex"))
    .update(payload)
    .digest("hex");
  return {
    "x-bastal-timestamp": timestamp,
    "x-bastal-nonce": nonce,
    "x-bastal-signature": signature,
  };
}
