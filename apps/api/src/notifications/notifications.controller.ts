import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiProperty, ApiTags } from "@nestjs/swagger";
import { IsBoolean, IsOptional } from "class-validator";
import { AuthGuard } from "../auth/auth.guard";
import { CurrentActor } from "../auth/current-actor.decorator";
import type { Actor } from "../auth/permissions";
import { RequestIntegrityGuard } from "../security/request-integrity.guard";
import { NotificationsService } from "./notifications.service";

/** The switches a user may change on their own notifications; anything else in the body is refused. */
class NotificationPreferencesDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  inAppEnabled?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  emailEnabled?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  financeEnabled?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  accountEnabled?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  securityEnabled?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  systemEnabled?: boolean;
}

@ApiTags("notifications")
@ApiBearerAuth()
@Controller("notifications")
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentActor() actor: Actor, @Query("includeArchived") includeArchived?: string) {
    return this.notifications.list(actor, includeArchived === "true");
  }

  @Post(":id/read")
  @UseGuards(RequestIntegrityGuard, AuthGuard)
  markRead(@CurrentActor() actor: Actor, @Param("id") id: string) {
    return this.notifications.markRead(actor, id);
  }

  @Post("read-all")
  @UseGuards(RequestIntegrityGuard, AuthGuard)
  markAllRead(@CurrentActor() actor: Actor) {
    return this.notifications.markAllRead(actor);
  }

  @Post(":id/archive")
  @UseGuards(RequestIntegrityGuard, AuthGuard)
  archive(@CurrentActor() actor: Actor, @Param("id") id: string) {
    return this.notifications.archive(actor, id);
  }

  @Delete(":id")
  @UseGuards(RequestIntegrityGuard, AuthGuard)
  remove(@CurrentActor() actor: Actor, @Param("id") id: string) {
    return this.notifications.remove(actor, id);
  }

  @Get("preferences")
  preferences(@CurrentActor() actor: Actor) {
    return this.notifications.preferences(actor);
  }

  @Patch("preferences")
  @UseGuards(RequestIntegrityGuard, AuthGuard)
  updatePreferences(@CurrentActor() actor: Actor, @Body() body: NotificationPreferencesDto) {
    return this.notifications.updatePreferences(actor, body);
  }
}
