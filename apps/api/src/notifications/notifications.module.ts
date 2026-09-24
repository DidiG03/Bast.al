import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { CryptoModule } from "../crypto/crypto.module";
import { SecurityModule } from "../security/security.module";
import { NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";

@Module({
  imports: [AuthModule, SecurityModule, CryptoModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
