import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Role } from "@prisma/client";
import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsDateString, IsIn, IsOptional, IsString, Matches, MaxLength, ValidateNested } from "class-validator";
import { AuthGuard } from "../auth/auth.guard";
import { CurrentActor } from "../auth/current-actor.decorator";
import { MfaGuard } from "../auth/mfa.guard";
import type { Actor } from "../auth/permissions";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { TRACKER_ID } from "./tracker-embed";
import { TrackerService } from "./tracker.service";


class TrackerQueryDto {
  @IsOptional()
  @IsIn(["sq", "en"])
  lang?: "sq" | "en";

  @IsOptional()
  @IsIn(["light", "dark"])
  theme?: "light" | "dark";
}

class TrackerFixtureDto {
  @Matches(TRACKER_ID)
  id!: string;

  @IsString()
  @MaxLength(120)
  home!: string;

  @IsString()
  @MaxLength(120)
  away!: string;

  @IsDateString()
  kickoff!: string;
}

class ImportFixturesDto {
  @IsArray()
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => TrackerFixtureDto)
  fixtures!: TrackerFixtureDto[];
}

class ManualMappingDto {
  /** The SportScore match id, or null to keep this match without a tracker. */
  @IsOptional()
  @Matches(TRACKER_ID)
  externalId?: string | null;
}

@ApiTags("tracker")
@ApiBearerAuth()
@UseGuards(AuthGuard, MfaGuard, RolesGuard)
@Controller("tracker")
export class TrackerController {
  constructor(private readonly tracker: TrackerService) {}

  /** The live tracker to show above a live match's markets, or { show: false }. */
  @Get("events/:id")
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER, Role.PLAYER)
  forEvent(@CurrentActor() actor: Actor, @Param("id") id: string, @Query() query: TrackerQueryDto) {
    return this.tracker.forEvent(actor, id, query.lang ?? "sq", query.theme ?? "light");
  }

  @Post("fixtures")
  @Roles(Role.SUPER_ADMIN)
  importFixtures(@Body() body: ImportFixturesDto) {
    return this.tracker.importFixtures(body.fixtures);
  }

  @Put("events/:id")
  @Roles(Role.SUPER_ADMIN)
  setManual(@Param("id") id: string, @Body() body: ManualMappingDto) {
    return this.tracker.setManual(id, body.externalId ?? null);
  }

  @Delete("events/:id")
  @Roles(Role.SUPER_ADMIN)
  clearManual(@Param("id") id: string) {
    return this.tracker.clearManual(id);
  }
}
