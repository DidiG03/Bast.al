import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Role } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { AuthenticatedRequest } from "./auth.guard";
import { ROLES_KEY } from "./roles.decorator";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const actor = request.actor;
    if (!actor || !required.includes(actor.role)) {
      await this.audit.log({
        actorId: actor?.id,
        action: "authz.failure",
        ipAddress: this.clientIp(request),
        metadata: {
          reason: "role_denied",
          required,
          actual: actor?.role ?? null,
        },
      });
      throw new ForbiddenException("Insufficient role");
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
