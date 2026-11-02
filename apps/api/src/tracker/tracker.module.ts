import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { SecurityModule } from "../security/security.module";
import { TrackerController } from "./tracker.controller";
import { TrackerService } from "./tracker.service";

/** The live match tracker (display only; see TrackerService). */
@Module({
  imports: [AuthModule, SecurityModule],
  controllers: [TrackerController],
  providers: [TrackerService],
})
export class TrackerModule {}
