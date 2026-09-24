import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Request } from "express";
import { ThreatIntelService } from "./threat-intel.service";

@Injectable()
export class IpBlockGuard implements CanActivate {
  constructor(private readonly threats: ThreatIntelService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const ip = this.clientIp(request) ?? "unknown";
    if (await this.threats.isBlocked(ip)) {
      throw new ForbiddenException("Temporarily blocked due to suspicious activity");
    }
    return true;
  }

  private clientIp(request: Request): string | undefined {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length > 0) {
      return forwarded.split(",")[0]?.trim();
    }
    return request.ip;
  }
}
