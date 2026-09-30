import { Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { InjectThrottlerOptions, InjectThrottlerStorage, ThrottlerGuard, type ThrottlerModuleOptions, type ThrottlerStorage } from "@nestjs/throttler";
import { Request } from "express";
import { ClerkService } from "../auth/clerk.service";
import { clientIp } from "./client-ip";

/**
 * Rate limits per signed-in account, or per visitor address for requests
 * without a valid session. Not per address alone: Players in one betting shop
 * share an internet connection, and our web server's own calls all come from
 * one address, so an address-wide limit would make everyone behind it wait
 * for each other. The session is verified (not just read) so nobody can get a
 * fresh allowance by making up an account id.
 */
@Injectable()
export class ClientThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly clerk: ClerkService,
  ) {
    super(options, storage, reflector);
  }

  protected async getTracker(request: Record<string, unknown>): Promise<string> {
    const req = request as unknown as Request;
    const session = await this.clerk.sessionFor(req);
    return session ? `user:${session.userId}` : `ip:${clientIp(req)}`;
  }
}
