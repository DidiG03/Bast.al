import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { NotificationCategory, NotificationSeverity, NotificationType } from "@prisma/client";
import { Observable, Subject } from "rxjs";
import { Actor } from "../auth/permissions";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../prisma.service";

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly streams = new Map<string, Subject<unknown>>();

  constructor(private readonly prisma: PrismaService, private readonly crypto: FieldEncryptionService) {}

  async list(actor: Actor, includeArchived = false) {
    const [items, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId: actor.id, ...(includeArchived ? {} : { archivedAt: null }) },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { id: true, type: true, category: true, severity: true, title: true, message: true, metadata: true, readAt: true, archivedAt: true, createdAt: true },
      }),
      this.prisma.notification.count({ where: { userId: actor.id, readAt: null } }),
    ]);
    return { items, unreadCount };
  }

  async markRead(actor: Actor, id: string) {
    const notification = await this.prisma.notification.findFirst({ where: { id, userId: actor.id } });
    if (!notification) throw new NotFoundException("Notification not found");
    return this.prisma.notification.update({ where: { id }, data: { readAt: new Date() }, select: { id: true, readAt: true } });
  }

  async markAllRead(actor: Actor) {
    await this.prisma.notification.updateMany({
      where: { userId: actor.id, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }

  async archive(actor: Actor, id: string) {
    return this.updateOwned(actor, id, { archivedAt: new Date() });
  }

  async remove(actor: Actor, id: string) {
    const notification = await this.prisma.notification.findFirst({ where: { id, userId: actor.id } });
    if (!notification) throw new NotFoundException("Notification not found");
    await this.prisma.notification.delete({ where: { id } });
    return { ok: true };
  }

  async preferences(actor: Actor) {
    return this.prisma.notificationPreference.upsert({
      where: { userId: actor.id },
      create: { userId: actor.id },
      update: {},
    });
  }

  async updatePreferences(actor: Actor, input: Partial<Record<"inAppEnabled" | "emailEnabled" | "financeEnabled" | "accountEnabled" | "securityEnabled" | "systemEnabled", boolean>>) {
    return this.prisma.notificationPreference.upsert({ where: { userId: actor.id }, create: { userId: actor.id, ...input }, update: input });
  }

  stream(actor: Actor): Observable<unknown> {
    let stream = this.streams.get(actor.id);
    if (!stream) {
      stream = new Subject<unknown>();
      this.streams.set(actor.id, stream);
    }
    return stream.asObservable();
  }

  /**
   * Notifications are a side effect, never the point of the call — a
   * notification failure must never fail (or roll back) the action that
   * triggered it, so this never throws.
   */
  async create(input: {
    userId: string;
    type: NotificationType;
    title: string;
    message: string;
    category?: NotificationCategory;
    severity?: NotificationSeverity;
    deepLink?: string;
    metadata?: Record<string, string | number | boolean | null>;
  }) {
    try {
      const preferences = await this.prisma.notificationPreference.findUnique({ where: { userId: input.userId } });
      const category = input.category ?? this.categoryFor(input.type);
      const enabled = !preferences || preferences.inAppEnabled && this.preferenceEnabled(preferences, category);
      if (!enabled) return null;
      const metadata = { ...(input.metadata ?? {}), ...(input.deepLink ? { deepLink: input.deepLink } : {}) };
      // Notification has no deepLink column — it only ever lives inside
      // metadata — so build the Prisma payload from an explicit field list
      // rather than spreading `input` (which still carries deepLink/metadata
      // in their raw, pre-merge form and would fail with an unknown-argument
      // error).
      const created = await this.prisma.notification.create({
        data: {
          userId: input.userId,
          type: input.type,
          title: input.title,
          message: input.message,
          category,
          severity: input.severity ?? this.severityFor(input.type),
          metadata,
        },
      });
      this.streams.get(input.userId)?.next(created);
      if (preferences?.emailEnabled && this.preferenceEnabled(preferences, category)) await this.sendEmail(input.userId, created.title, created.message);
      return created;
    } catch (error) {
      this.logger.error(`Failed to create notification (userId=${input.userId}, type=${input.type}): ${String(error)}`);
      return null;
    }
  }

  private async updateOwned(actor: Actor, id: string, data: { readAt?: Date; archivedAt?: Date }) {
    const notification = await this.prisma.notification.findFirst({ where: { id, userId: actor.id } });
    if (!notification) throw new NotFoundException("Notification not found");
    return this.prisma.notification.update({ where: { id }, data, select: { id: true, readAt: true, archivedAt: true } });
  }

  private categoryFor(type: NotificationType): NotificationCategory {
    if (type === NotificationType.FUNDS_RECEIVED || type === NotificationType.COMMISSION_RATE_UPDATED) return NotificationCategory.FINANCE;
    if (type === NotificationType.SUSPICIOUS_LOGIN) return NotificationCategory.SECURITY;
    if (type === NotificationType.ACCOUNT_SUSPENDED || type === NotificationType.ACCOUNT_UPDATED || type === NotificationType.ACCOUNT_REASSIGNED) return NotificationCategory.ACCOUNT;
    return NotificationCategory.SYSTEM;
  }

  private severityFor(type: NotificationType): NotificationSeverity {
    return type === NotificationType.SUSPICIOUS_LOGIN ? NotificationSeverity.CRITICAL : type === NotificationType.FUNDS_RECEIVED ? NotificationSeverity.SUCCESS : NotificationSeverity.INFO;
  }

  private preferenceEnabled(preferences: { financeEnabled: boolean; accountEnabled: boolean; securityEnabled: boolean; systemEnabled: boolean }, category: NotificationCategory) {
    return category === NotificationCategory.FINANCE ? preferences.financeEnabled : category === NotificationCategory.ACCOUNT ? preferences.accountEnabled : category === NotificationCategory.SECURITY ? preferences.securityEnabled : preferences.systemEnabled;
  }

  private async sendEmail(userId: string, subject: string, message: string) {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.NOTIFICATION_EMAIL_FROM;
    if (!apiKey || !from) return;
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { emailCipher: true } });
    if (!user) return;
    const to = this.crypto.decrypt(user.emailCipher);
    await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: [to], subject, text: message }) });
  }
}
