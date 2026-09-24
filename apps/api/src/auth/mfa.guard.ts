import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuditService } from "../audit/audit.service";
import { AuthenticatedRequest } from "./auth.guard";
import { ClerkService } from "./clerk.service";
import { roleRequiresMfa } from "./permissions";

/**
 * Hard-blocks Super Admin / Owner when MFA_ENFORCEMENT_ENABLED=true and TOTP is not enrolled.
 * Clerk Hobby (free) does not include MFA — leave the flag false until Pro.
 */
@Injectable()
export class MfaGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly clerk: ClerkService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.config.get<string>("MFA_ENFORCEMENT_ENABLED") !== "true") {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const actor = request.actor;
    if (!actor || !roleRequiresMfa(actor.role)) return true;

    const enabled = await this.clerk.hasTotpEnabled(actor.clerkId);
    if (!enabled) {
      await this.audit.log({
        actorId: actor.id,
        action: "authz.failure",
        ipAddress: this.clientIp(request),
        metadata: { reason: "mfa_required" },
      });
      throw new ForbiddenException("Two-factor authentication is required for this role");
    }
    return true;
  }

  private clientIp(request: AuthenticatedRequest): string | undefined {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length > 0) {
      return forwarded.split(",")[0]?.trim();
    }
    return request.ip;
  }
}
