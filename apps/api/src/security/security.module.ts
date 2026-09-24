import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { AuditModule } from "../audit/audit.module";
import { HoneypotController } from "./honeypot.controller";
import { IpBlockGuard } from "./ip-block.guard";
import { RequestIdMiddleware } from "./request-id.middleware";
import { RequestIntegrityGuard } from "./request-integrity.guard";
import { SanitizedExceptionFilter } from "./sanitized-exception.filter";
import { ThreatIntelService } from "./threat-intel.service";

@Module({
  imports: [AuditModule],
  controllers: [HoneypotController],
  providers: [
    ThreatIntelService,
    RequestIntegrityGuard,
    IpBlockGuard,
    { provide: APP_GUARD, useClass: IpBlockGuard },
    { provide: APP_FILTER, useClass: SanitizedExceptionFilter },
  ],
  exports: [ThreatIntelService, RequestIntegrityGuard, IpBlockGuard],
})
export class SecurityModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes("*");
  }
}
