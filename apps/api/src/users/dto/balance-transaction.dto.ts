import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean, IsNumber, IsString, IsPositive, Max, MaxLength, Min, MinLength, ValidateIf } from "class-validator";

/** Delegate credit to a direct child (Owner→Manager, Owner→Player, Manager→Player). */
export class DelegateCreditDto {
  @ApiProperty({ example: 100, description: "Amount to move from the caller's own balance to the target's" })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(1000000)
  amount!: number;

  @ApiProperty({ example: "Weekly float" })
  @IsString()
  @MinLength(3)
  @MaxLength(240)
  reason!: string;
}

/** Pull credit back from a direct child into the caller's own balance. */
export class ReclaimCreditDto {
  @ApiProperty({ example: 100, description: "Amount to move from the target's balance back to the caller's" })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(100000000)
  amount!: number;

  @ApiProperty({ example: "Closing the account" })
  @IsString()
  @MinLength(3)
  @MaxLength(240)
  reason!: string;
}

/** Super-Admin-only correction with no counterparty; amount may be negative. */
export class AdjustBalanceDto {
  @ApiProperty({ example: -50, description: "Signed amount to apply directly to the target's balance" })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(-1000000)
  @Max(1000000)
  amount!: number;

  @ApiProperty({ example: "Correcting a data-entry error" })
  @IsString()
  @MinLength(3)
  @MaxLength(240)
  reason!: string;
}

export class BalanceLimitDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(100000000)
  limit!: number;
}

/** A Manager's personal approval limit; null goes back to the platform default. */
export class ApprovalLimitDto {
  @ApiProperty({ example: 25000, nullable: true, description: "Delegations up to this amount skip approval. null = platform default" })
  @ValidateIf((_, value) => value !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000000)
  limit!: number | null;
}

/** Approve (true) or reject (false) a transfer waiting for sign-off. Only a real true approves. */
export class ApproveTransactionDto {
  @ApiProperty()
  @IsBoolean()
  approve!: boolean;
}
