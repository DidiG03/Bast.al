import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "crypto";
import { Injectable, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma.service";

/**
 * Application-level encryption for sensitive identity fields at rest.
 * - AES-256-GCM for confidentiality + integrity of ciphertext
 * - HMAC-SHA256 blind index for equality lookups without storing plaintext
 *
 * Passwords are never stored here (Clerk). Usernames stay plaintext (public login id).
 */
@Injectable()
export class FieldEncryptionService implements OnModuleInit {
  private readonly dataKey: Buffer;
  private readonly indexKey: Buffer;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const hex = this.config.getOrThrow<string>("FIELD_ENCRYPTION_KEY").trim();
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error("FIELD_ENCRYPTION_KEY must be 64 hex characters (32 bytes). Generate with: openssl rand -hex 32");
    }
    const master = Buffer.from(hex, "hex");
    this.dataKey = Buffer.from(hkdfSync("sha256", master, "bastal-salt", "field-data-v1", 32));
    this.indexKey = Buffer.from(hkdfSync("sha256", master, "bastal-salt", "field-index-v1", 32));
  }

  async onModuleInit() {
    await this.migrateLegacyPlaintextEmails();
  }

  blindIndex(plaintext: string): string {
    return createHmac("sha256", this.indexKey)
      .update(plaintext.normalize("NFKC").toLowerCase())
      .digest("base64url");
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.dataKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
  }

  decrypt(payload: string): string {
    const [ivB64, tagB64, dataB64] = payload.split(".");
    if (!ivB64 || !tagB64 || !dataB64) {
      throw new Error("Invalid ciphertext format");
    }
    const iv = Buffer.from(ivB64, "base64url");
    const tag = Buffer.from(tagB64, "base64url");
    const data = Buffer.from(dataB64, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", this.dataKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  }

  isCiphertext(value: string): boolean {
    if (value.includes("@")) return false;
    const parts = value.split(".");
    return parts.length === 3 && parts.every((p) => p.length > 0);
  }

  safeEqualHash(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  }

  /** One-time upgrade path: plaintext emails → cipher + blind index. */
  private async migrateLegacyPlaintextEmails() {
    const rows = await this.prisma.user.findMany({
      select: { id: true, emailCipher: true, emailHash: true },
    });
    for (const row of rows) {
      if (this.isCiphertext(row.emailCipher) && row.emailHash) continue;
      if (!row.emailCipher.includes("@")) continue;
      const plaintext = row.emailCipher.toLowerCase();
      await this.prisma.user.update({
        where: { id: row.id },
        data: {
          emailCipher: this.encrypt(plaintext),
          emailHash: this.blindIndex(plaintext),
        },
      });
    }
  }
}
