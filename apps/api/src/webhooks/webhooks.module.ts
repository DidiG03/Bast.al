import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { CryptoModule } from "../crypto/crypto.module";
import { ClerkWebhookController } from "./clerk-webhook.controller";
import { ClerkWebhookService } from "./clerk-webhook.service";

@Module({
  imports: [AuditModule, CryptoModule],
  controllers: [ClerkWebhookController],
  providers: [ClerkWebhookService],
})
export class WebhooksModule {}

