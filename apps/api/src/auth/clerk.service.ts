import { createClerkClient, verifyToken } from "@clerk/backend";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class ClerkService {
  private readonly logger = new Logger(ClerkService.name);
  private readonly secretKey: string;
  private readonly client: ReturnType<typeof createClerkClient>;

  constructor(private readonly config: ConfigService) {
    this.secretKey = this.config.getOrThrow<string>("CLERK_SECRET_KEY");
    this.client = createClerkClient({ secretKey: this.secretKey });
  }

  get api() {
    return this.client;
  }

  async verifySessionToken(token: string): Promise<{ userId: string; sessionId?: string }> {
    const payload = await verifyToken(token, { secretKey: this.secretKey });
    if (!payload.sub) {
      throw new Error("Clerk token missing subject");
    }
    return { userId: payload.sub, sessionId: typeof payload.sid === "string" ? payload.sid : undefined };
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
