import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { SecurityModule } from "../security/security.module";
import { AuthGuard } from "./auth.guard";
import { ClerkService } from "./clerk.service";
import { MfaGuard } from "./mfa.guard";
import { RolesGuard } from "./roles.guard";

@Module({
  imports: [AuditModule, SecurityModule],
  providers: [ClerkService, AuthGuard, RolesGuard, MfaGuard],
  exports: [ClerkService, AuthGuard, RolesGuard, MfaGuard, AuditModule],
})
export class AuthModule {}
