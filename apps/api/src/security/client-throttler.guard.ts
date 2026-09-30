import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { Request } from "express";
import { clientIp } from "./client-ip";

/**
 * Rate limits per visitor. The default key is Express's `req.ip`, which behind
 * the web app and a hosting proxy is the same address for everyone, so all
 * users would share one limit.
 */
@Injectable()
export class ClientThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(request: Record<string, unknown>): Promise<string> {
    return clientIp(request as unknown as Request);
  }
}
