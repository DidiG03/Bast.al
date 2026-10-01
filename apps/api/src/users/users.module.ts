import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { CryptoModule } from "../crypto/crypto.module";
import { SecurityModule } from "../security/security.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { DataResetService } from "./data-reset.service";
import { HierarchyService } from "./hierarchy.service";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

@Module({
  imports: [AuthModule, CryptoModule, SecurityModule, NotificationsModule],
  controllers: [UsersController],
  providers: [UsersService, HierarchyService, DataResetService],
  exports: [UsersService, HierarchyService],
})
export class UsersModule {}
