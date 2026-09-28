import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AuthGuard } from "./auth/auth.guard";
import { MfaGuard } from "./auth/mfa.guard";
import { PrismaService } from "./prisma.service";

@ApiTags("events")
@Controller("events")
export class EventsController {
  constructor(private readonly prisma: PrismaService) {}

  /** Signed-in accounts only: odds and fixtures aren't public. */
  @Get()
  @ApiBearerAuth()
  @UseGuards(AuthGuard, MfaGuard)
  list() { return this.prisma.event.findMany({ where: { hidden: false }, orderBy: { startsAt: "asc" }, take: 50 }); }
}
