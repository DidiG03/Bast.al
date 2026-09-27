import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiProperty, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Role } from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import { IsString, Matches, MaxLength, MinLength } from "class-validator";
import { AuthGuard, AuthenticatedRequest } from "../auth/auth.guard";
import { CurrentActor } from "../auth/current-actor.decorator";
import { MfaGuard } from "../auth/mfa.guard";
import type { Actor } from "../auth/permissions";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { clientIp } from "../security/client-ip";
import { RequestIntegrityGuard } from "../security/request-integrity.guard";
import { CreateUserDto } from "./dto/create-user.dto";
import { AdjustBalanceDto, ApprovalLimitDto, BalanceLimitDto, DelegateCreditDto, ReclaimCreditDto } from "./dto/balance-transaction.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { ReassignUserDto } from "./dto/reassign-user.dto";
import { AuditQueryDto } from "./dto/audit-query.dto";
import { ManagerCapacityDto } from "./dto/manager-capacity.dto";
import { CommissionRateDto } from "./dto/commission.dto";
import { UsersService } from "./users.service";

class BootstrapSuperAdminDto {
  @ApiProperty({ description: "Clerk user id (user_…)" })
  @IsString()
  clerkId!: string;

  @ApiProperty({ example: "superadmin" })
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9_]+$/)
  username!: string;

  @ApiProperty()
  @IsString()
  @MinLength(16)
  bootstrapSecret!: string;
}

@ApiTags("users")
@Controller("users")
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly config: ConfigService,
  ) {}

  /**
   * One-time: after creating the first user in the Clerk Dashboard (sign-ups disabled
   * for the public app), link them as Super Admin. Refused once any Super Admin exists.
   */
  @Post("bootstrap/super-admin")
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @UseGuards(RequestIntegrityGuard)
  bootstrap(@Body() dto: BootstrapSuperAdminDto, @Req() req: AuthenticatedRequest) {
    return this.users.bootstrapSuperAdmin({
      clerkId: dto.clerkId,
      username: dto.username,
      bootstrapSecret: dto.bootstrapSecret,
      expectedSecret: this.config.get<string>("BOOTSTRAP_SECRET") ?? "",
      ipAddress: clientIp(req),
    });
  }

  @Get("me")
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  me(@CurrentActor() actor: Actor) {
    const mfaEnforcement = this.config.get<string>("MFA_ENFORCEMENT_ENABLED") === "true";
    return this.users.me(actor, mfaEnforcement);
  }

  @Get("me/security")
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  security(@CurrentActor() actor: Actor) {
    return this.users.securityOverview(actor);
  }

  @Post("me/sessions/:sessionId/revoke")
  @ApiBearerAuth()
  @UseGuards(RequestIntegrityGuard, AuthGuard)
  revokeSession(@CurrentActor() actor: Actor, @Param("sessionId") sessionId: string) {
    return this.users.revokeSession(actor, sessionId);
  }

  @Post("me/sessions/revoke-others")
  @ApiBearerAuth()
  @UseGuards(RequestIntegrityGuard, AuthGuard)
  revokeOthers(@CurrentActor() actor: Actor, @Req() req: AuthenticatedRequest) {
    return this.users.revokeOtherSessions(actor, req.headers["x-clerk-session-id"] as string | undefined);
  }

  @Get("security-settings")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  securitySettings(@CurrentActor() actor: Actor) {
    return this.users.securitySettings(actor);
  }

  @Post("security-settings")
  @ApiBearerAuth()
  @UseGuards(RequestIntegrityGuard, AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  updateSecuritySettings(@CurrentActor() actor: Actor, @Body() body: { failLimit: number; windowMs: number; banMs: number }) {
    return this.users.updateSecuritySettings(actor, body);
  }

  @Get()
  @ApiBearerAuth()
  @UseGuards(AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER)
  list(@CurrentActor() actor: Actor) {
    return this.users.listVisible(actor);
  }

  @Get("report")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER)
  report(@CurrentActor() actor: Actor) {
    return this.users.report(actor);
  }

  @Get(":id/commission-rate")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER)
  commissionRate(@CurrentActor() actor: Actor, @Param("id") id: string) {
    return this.users.commissionRate(actor, id);
  }

  @Post(":id/commission-rate")
  @ApiBearerAuth()
  @UseGuards(RequestIntegrityGuard, AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER)
  setCommissionRate(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() dto: CommissionRateDto, @Req() req: AuthenticatedRequest) {
    return this.users.setCommissionRate(actor, id, dto.rate, clientIp(req));
  }

  @Get("audit")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER)
  audit(@CurrentActor() actor: Actor, @Query() query: AuditQueryDto) {
    return this.users.auditLog(actor, query);
  }

  @Post()
  @ApiBearerAuth()
  @UseGuards(RequestIntegrityGuard, AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  create(
    @CurrentActor() actor: Actor,
    @Body() dto: CreateUserDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.users.createUser(actor, dto, clientIp(req));
  }

  @Get(":id/balance/ledger")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER, Role.PLAYER)
  balanceLedger(@CurrentActor() actor: Actor, @Param("id") id: string) {
    return this.users.balanceLedger(actor, id);
  }

  @Post(":id/delegate")
  @ApiBearerAuth()
  @UseGuards(RequestIntegrityGuard, AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER)
  delegateCredit(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Body() dto: DelegateCreditDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.users.delegateCredit(actor, id, dto, clientIp(req));
  }

  @Post(":id/reclaim")
  @ApiBearerAuth()
  @UseGuards(RequestIntegrityGuard, AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER)
  reclaimCredit(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Body() dto: ReclaimCreditDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.users.reclaimCredit(actor, id, dto, clientIp(req));
  }

  @Post(":id/adjust-balance")
  @ApiBearerAuth()
  @UseGuards(RequestIntegrityGuard, AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  adjustBalance(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Body() dto: AdjustBalanceDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.users.adjustBalance(actor, id, dto, clientIp(req));
  }

  @Post(":id/balance-limit")
  @ApiBearerAuth()
  @UseGuards(RequestIntegrityGuard, AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER)
  balanceLimit(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() dto: BalanceLimitDto, @Req() req: AuthenticatedRequest) {
    return this.users.setBalanceLimit(actor, id, dto.limit, clientIp(req));
  }

  @Post(":id/manager-capacity")
  @ApiBearerAuth()
  @UseGuards(RequestIntegrityGuard, AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER)
  managerCapacity(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() dto: ManagerCapacityDto, @Req() req: AuthenticatedRequest) {
    return this.users.setManagerCapacity(actor, id, dto.capacity, clientIp(req));
  }

  @Post(":id/approval-limit")
  @ApiBearerAuth()
  @UseGuards(RequestIntegrityGuard, AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER)
  approvalLimit(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() dto: ApprovalLimitDto, @Req() req: AuthenticatedRequest) {
    return this.users.setApprovalLimit(actor, id, dto.limit, clientIp(req));
  }

  @Get("balance/pending")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER)
  pendingApprovals(@CurrentActor() actor: Actor) {
    return this.users.pendingApprovals(actor);
  }

  @Get("balance/transactions/:transactionId")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER, Role.PLAYER)
  transaction(@CurrentActor() actor: Actor, @Param("transactionId") transactionId: string) {
    return this.users.transactionDetails(actor, transactionId);
  }

  @Post("balance/transactions/:transactionId/approve")
  @ApiBearerAuth()
  @UseGuards(RequestIntegrityGuard, AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER)
  approve(@CurrentActor() actor: Actor, @Param("transactionId") transactionId: string, @Body("approve") approve: boolean, @Req() req: AuthenticatedRequest) {
    return this.users.approveBalance(actor, transactionId, approve, clientIp(req));
  }

  @Get(":id/balance/statement")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER, Role.PLAYER)
  statement(@CurrentActor() actor: Actor, @Param("id") id: string, @Query("from") from?: string, @Query("to") to?: string) {
    return this.users.balanceStatement(actor, id, from, to);
  }

  @Get("financial-report")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER)
  financialReport(@CurrentActor() actor: Actor, @Query("from") from?: string, @Query("to") to?: string) {
    return this.users.financialReport(actor, from, to);
  }

  @Post(":id/suspend")
  @ApiBearerAuth()
  @UseGuards(RequestIntegrityGuard, AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  suspend(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.users.suspend(actor, id, clientIp(req));
  }

  @Post(":id/unsuspend")
  @ApiBearerAuth()
  @UseGuards(RequestIntegrityGuard, AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  unsuspend(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.users.unsuspend(actor, id, clientIp(req));
  }

  @Post(":id/reassign")
  @ApiBearerAuth()
  @UseGuards(RequestIntegrityGuard, AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER)
  reassign(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Body() dto: ReassignUserDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.users.reassignPlayer(actor, id, dto.managerId, clientIp(req));
  }

  @Get(":id/reassignment-preview")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER)
  reassignmentPreview(@CurrentActor() actor: Actor, @Param("id") id: string, @Query("managerId") managerId: string) {
    return this.users.reassignmentPreview(actor, id, managerId);
  }

  @Post(":id/update")
  @ApiBearerAuth()
  @UseGuards(RequestIntegrityGuard, AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER)
  update(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Body() dto: UpdateUserDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.users.updateUser(actor, id, dto, clientIp(req));
  }

  @Post(":id/delete")
  @ApiBearerAuth()
  @UseGuards(RequestIntegrityGuard, AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER)
  delete(@CurrentActor() actor: Actor, @Param("id") id: string, @Req() req: AuthenticatedRequest) {
    return this.users.deleteUser(actor, id, clientIp(req));
  }

  @Get(":id")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, MfaGuard)
  getOne(@CurrentActor() actor: Actor, @Param("id") id: string, @Req() req: AuthenticatedRequest) {
    return this.users.getById(actor, id, clientIp(req));
  }
}
