import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Request } from "express";
import { clientIp } from "./client-ip";
import { ThreatIntelService } from "./threat-intel.service";

@Injectable()
export class IpBlockGuard implements CanActivate {
  constructor(private readonly threats: ThreatIntelService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const ip = clientIp(request);
    if (await this.threats.isBlocked(ip)) {
      throw new ForbiddenException("Temporarily blocked due to suspicious activity");
    }
    return true;
  }
}
