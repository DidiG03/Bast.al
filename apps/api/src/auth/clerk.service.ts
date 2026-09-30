import { createClerkClient, verifyToken } from "@clerk/backend";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export type VerifiedSession = { userId: string; sessionId?: string };

/** The token from an `Authorization: Bearer …` header, or null. */
export function bearerToken(request: { headers: Record<string, unknown> }): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

@Injectable()
export class ClerkService {
  private readonly logger = new Logger(ClerkService.name);
  private readonly secretKey: string;
  private readonly client: ReturnType<typeof createClerkClient>;
  /** One check per request: the rate limiter and AuthGuard both need to know who's calling. */
  private readonly checked = new WeakMap<object, Promise<VerifiedSession | null>>();

  constructor(private readonly config: ConfigService) {
    this.secretKey = this.config.getOrThrow<string>("CLERK_SECRET_KEY");
    this.client = createClerkClient({ secretKey: this.secretKey });
  }

  get api() {
    return this.client;
  }

  async verifySessionToken(token: string): Promise<VerifiedSession> {
    const payload = await verifyToken(token, { secretKey: this.secretKey });
    if (!payload.sub) {
      throw new Error("Clerk token missing subject");
    }
    return { userId: payload.sub, sessionId: typeof payload.sid === "string" ? payload.sid : undefined };
  }

  /**
   * Who a request is from, if its bearer token verifies; null when it has no
   * token or the token is invalid or expired. Checked once per request.
   */
  sessionFor(request: { headers: Record<string, unknown> }): Promise<VerifiedSession | null> {
    let result = this.checked.get(request);
    if (!result) {
      const token = bearerToken(request);
      result = token ? this.verifySessionToken(token).catch(() => null) : Promise.resolve(null);
      this.checked.set(request, result);
    }
    return result;
  }

  /** Creates a Clerk user identified by username; email is intentionally not required. */
  async createUser(input: { username: string; password: string }) {
    return this.client.users.createUser({
      username: input.username,
      password: input.password,
      skipPasswordChecks: false,
    });
  }

  async deleteUser(clerkId: string) {
    try {
      await this.client.users.deleteUser(clerkId);
    } catch (error) {
      this.logger.warn(`Failed to delete Clerk user ${clerkId}: ${String(error)}`);
    }
  }

  async updateUser(clerkId: string, input: { username?: string; password?: string }) {
    return this.client.users.updateUser(clerkId, input);
  }

  async deleteUserStrict(clerkId: string) {
    await this.client.users.deleteUser(clerkId);
  }

  async getUser(clerkId: string) {
    return this.client.users.getUser(clerkId);
  }

  /** True when the Clerk user has at least one second factor enrolled. */
  async hasTotpEnabled(clerkId: string): Promise<boolean> {
    const user = await this.getUser(clerkId);
    return Boolean(user.totpEnabled || user.twoFactorEnabled);
  }
}
