import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { SecurityModule } from "../security/security.module";
import { PrismaService } from "../prisma.service";
import { TrackerController } from "./tracker.controller";
import { TrackerService } from "./tracker.service";

/** The live match tracker (display only; see TrackerService). */
@Module({
  imports: [AuthModule, SecurityModule],
  controllers: [TrackerController],
  providers: [{ provide: TrackerService, useFactory: (prisma: PrismaService) => new TrackerService(prisma), inject: [PrismaService] }],
})
export class TrackerModule {}
