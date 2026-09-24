import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { PrismaService } from "./prisma.service";

@ApiTags("events")
@Controller("events")
export class EventsController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() list() { return this.prisma.event.findMany({ orderBy: { startsAt: "asc" }, take: 50 }); }
}
