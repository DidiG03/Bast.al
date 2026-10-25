import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Role } from "@prisma/client";
import { AuthGuard } from "../auth/auth.guard";
import { CurrentActor } from "../auth/current-actor.decorator";
import { MfaGuard } from "../auth/mfa.guard";
import type { Actor } from "../auth/permissions";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { BaseMarginDto, EventsQueryDto, FeedDelayQueryDto, LeaguesDto, OverrideDto, SelectionsQueryDto, TeamMarginDto, TopEventsQueryDto, TeamQueryDto, UpdateEventDto } from "./odds.dto";
import { OddsService } from "./odds.service";

@ApiTags("odds")
@ApiBearerAuth()
@UseGuards(AuthGuard, MfaGuard, RolesGuard)
@Controller("odds")
export class OddsController {
  constructor(private readonly odds: OddsService) {}

  @Get("settings")
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER, Role.PLAYER)
  settings(@CurrentActor() actor: Actor, @Query() query: TeamQueryDto) {
    return this.odds.settings(actor, query.ownerId);
  }

  @Get("events")
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER, Role.PLAYER)
  events(@CurrentActor() actor: Actor, @Query() query: EventsQueryDto) {
    return this.odds.events(actor, query.filter, query.ownerId, query.view, query.sport);
  }

  /** A Player's home page: the few matches worth showing first. */
  @Get("top-events")
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER, Role.PLAYER)
  topEvents(@CurrentActor() actor: Actor, @Query() query: TopEventsQueryDto) {
    return this.odds.topEvents(actor, query.count, query.sport);
  }

  @Get("events/:id")
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER, Role.PLAYER)
  event(@CurrentActor() actor: Actor, @Param("id") id: string, @Query() query: TeamQueryDto) {
    return this.odds.event(actor, id, query.ownerId);
  }

  /** A football match's timeline, numbers and team sheets. */
  @Get("events/:id/centre")
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER, Role.PLAYER)
  matchCentre(@CurrentActor() actor: Actor, @Param("id") id: string) {
    return this.odds.matchCentre(actor, id);
  }

  /** The matches this account starred. */
  @Get("favourites")
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER, Role.PLAYER)
  favourites(@CurrentActor() actor: Actor) {
    return this.odds.favourites(actor);
  }

  @Put("favourites/:eventId")
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER, Role.PLAYER)
  star(@CurrentActor() actor: Actor, @Param("eventId") eventId: string) {
    return this.odds.setFavourite(actor, eventId, true);
  }

  @Delete("favourites/:eventId")
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER, Role.PLAYER)
  unstar(@CurrentActor() actor: Actor, @Param("eventId") eventId: string) {
    return this.odds.setFavourite(actor, eventId, false);
  }

  /** The kinds of market this account starred: they show first on every match that has them. */
  @Get("favourite-markets")
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER, Role.PLAYER)
  favouriteMarkets(@CurrentActor() actor: Actor) {
    return this.odds.favouriteMarkets(actor);
  }

  @Put("favourite-markets/:marketKey")
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER, Role.PLAYER)
  starMarket(@CurrentActor() actor: Actor, @Param("marketKey") marketKey: string) {
    return this.odds.setFavouriteMarket(actor, marketKey, true);
  }

  @Delete("favourite-markets/:marketKey")
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER, Role.PLAYER)
  unstarMarket(@CurrentActor() actor: Actor, @Param("marketKey") marketKey: string) {
    return this.odds.setFavouriteMarket(actor, marketKey, false);
  }

  /** A bet slip's picks: current price and whether each can still be bet on. */
  @Get("selections")
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER, Role.PLAYER)
  selections(@CurrentActor() actor: Actor, @Query() query: SelectionsQueryDto) {
    return this.odds.selections(actor, query.ids.split(","), query.ownerId);
  }

  @Get("selections/:id/history")
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER, Role.PLAYER)
  priceHistory(@CurrentActor() actor: Actor, @Param("id") id: string) {
    return this.odds.priceHistory(actor, id);
  }

  @Put("settings/base-margin")
  @Roles(Role.SUPER_ADMIN)
  setBaseMargin(@CurrentActor() actor: Actor, @Body() body: BaseMarginDto) {
    return this.odds.setBaseMargin(actor, body.margin);
  }

  @Put("settings/team-margin")
  @Roles(Role.SUPER_ADMIN, Role.OWNER)
  setTeamMargin(@CurrentActor() actor: Actor, @Body() body: TeamMarginDto, @Query() query: TeamQueryDto) {
    return this.odds.setTeamMargin(actor, body.margin, query.ownerId);
  }

  @Put("overrides/:selectionId")
  @Roles(Role.SUPER_ADMIN, Role.OWNER)
  setOverride(@CurrentActor() actor: Actor, @Param("selectionId") selectionId: string, @Body() body: OverrideDto, @Query() query: TeamQueryDto) {
    return this.odds.setOverride(actor, selectionId, body.odds, query.ownerId);
  }

  @Delete("overrides/:selectionId")
  @Roles(Role.SUPER_ADMIN, Role.OWNER)
  clearOverride(@CurrentActor() actor: Actor, @Param("selectionId") selectionId: string, @Query() query: TeamQueryDto) {
    return this.odds.clearOverride(actor, selectionId, query.ownerId);
  }

  @Patch("events/:id")
  @Roles(Role.SUPER_ADMIN)
  updateEvent(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: UpdateEventDto) {
    return this.odds.updateEvent(actor, id, body);
  }

  @Get("feed-delay")
  @Roles(Role.SUPER_ADMIN)
  feedDelay(@Query() query: FeedDelayQueryDto) {
    return this.odds.feedDelay(query.days ?? 7);
  }

  @Get("live-health")
  @Roles(Role.SUPER_ADMIN)
  liveHealth(@Query() query: FeedDelayQueryDto) {
    return this.odds.liveHealth(query.days ?? 1);
  }

  @Get("leagues")
  @Roles(Role.SUPER_ADMIN)
  leagues() {
    return this.odds.leagues();
  }

  @Put("leagues")
  @Roles(Role.SUPER_ADMIN)
  setLeagues(@CurrentActor() actor: Actor, @Body() body: LeaguesDto) {
    return this.odds.setLeagues(actor, body);
  }

  @Post("sync")
  @Roles(Role.SUPER_ADMIN)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  sync(@CurrentActor() actor: Actor) {
    return this.odds.syncNow(actor);
  }
}
