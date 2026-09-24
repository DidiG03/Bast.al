import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { UserStatus } from "@prisma/client";
import { Webhook } from "svix";
import { AuditService } from "../audit/audit.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../prisma.service";

type ClerkEmailAddress = { email_address: string; id: string };
type ClerkUserEventData = {
  id: string;
  email_addresses?: ClerkEmailAddress[];
  primary_email_address_id?: string | null;
  deleted?: boolean;
};

type ClerkWebhookEvent = {
  type: string;
  data: ClerkUserEventData;
};

@Injectable()
export class ClerkWebhookService {
  private readonly logger = new Logger(ClerkWebhookService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: FieldEncryptionService,
  ) {}

  async handle(input: {
    payload: string;
    headers: Record<string, string>;
  }) {
    const secret = this.config.getOrThrow<string>("CLERK_WEBHOOK_SECRET");
    const wh = new Webhook(secret);

    let event: ClerkWebhookEvent;
    try {
      event = wh.verify(input.payload, input.headers) as unknown as ClerkWebhookEvent;
    } catch {
      throw new UnauthorizedException("Invalid webhook signature");
    }

    switch (event.type) {
      case "user.created":
        this.logger.log(`Ignoring user.created for ${event.data.id} (admin-provisioned only)`);
        return { ok: true, ignored: true };

      case "user.updated":
        return this.syncIdentity(event.data);

      case "user.deleted":
        return this.suspendOnDelete(event.data);

      default:
        return { ok: true, ignored: true };
    }
  }

  private primaryEmail(data: ClerkUserEventData): string | null {
    const emails = data.email_addresses ?? [];
    const primary = emails.find((e) => e.id === data.primary_email_address_id);
    return (primary ?? emails[0])?.email_address?.toLowerCase() ?? null;
  }

  /** Sync encrypted email only — never touch role or parent_id. */
  private async syncIdentity(data: ClerkUserEventData) {
    const email = this.primaryEmail(data);
    if (!email) return { ok: true, skipped: "no_email" };

    const existing = await this.prisma.user.findUnique({ where: { clerkId: data.id } });
    if (!existing) {
      this.logger.warn(`user.updated for unknown clerk_id ${data.id}; ignoring`);
      return { ok: true, skipped: "unknown_user" };
    }

    const emailHash = this.crypto.blindIndex(email);
    if (this.crypto.safeEqualHash(existing.emailHash, emailHash)) {
      return { ok: true, unchanged: true };
    }

    const updated = await this.prisma.user.update({
      where: { clerkId: data.id },
      data: {
        emailCipher: this.crypto.encrypt(email),
        emailHash,
      },
    });

    await this.audit.log({
      actorId: updated.id,
      action: "user.identity_sync",
      targetId: updated.id,
      metadata: { synced: "email_hash" },
    });

    return { ok: true, synced: true };
  }

  private async suspendOnDelete(data: ClerkUserEventData) {
    const existing = await this.prisma.user.findUnique({ where: { clerkId: data.id } });
    if (!existing) {
      return { ok: true, skipped: "unknown_user" };
    }

    if (existing.status === UserStatus.SUSPENDED) {
      return { ok: true, alreadySuspended: true };
    }

    const updated = await this.prisma.user.update({
      where: { clerkId: data.id },
      data: { status: UserStatus.SUSPENDED },
    });

    await this.audit.log({
      actorId: updated.id,
      action: "user.suspend_from_clerk_delete",
      targetId: updated.id,
      metadata: { clerkId: data.id },
    });

    return { ok: true, suspended: true };
  }
}
