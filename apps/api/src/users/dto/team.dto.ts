import { ApiProperty } from "@nestjs/swagger";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsNumber, IsOptional, IsPositive, IsString, Max, Min, ValidateIf } from "class-validator";

/** An Owner's team-wide settings. Send null to turn one off; leave it out to keep it. */
export class TeamSettingsDto {
  @ApiProperty({ required: false, nullable: true, example: 50, description: "Alert when a Manager or Player drops below this balance" })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000000)
  lowBalanceThreshold?: number | null;

  @ApiProperty({ required: false, nullable: true, example: 20000, description: "Approval limit for Managers without their own" })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000000)
  managerApprovalLimit?: number | null;
}

export class BulkActionDto {
  @ApiProperty({ enum: ["suspend", "unsuspend", "delegate", "reassign"] })
  @IsIn(["suspend", "unsuspend", "delegate", "reassign"])
  action!: "suspend" | "unsuspend" | "delegate" | "reassign";

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  ids!: string[];

  @ApiProperty({ required: false, description: "delegate: amount sent to each account" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(1000000)
  amount?: number;

  @ApiProperty({ required: false, description: "reassign: the new Manager or Owner" })
  @IsOptional()
  @IsString()
  parentId?: string;
}
