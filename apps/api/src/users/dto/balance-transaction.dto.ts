import { ApiProperty } from "@nestjs/swagger";
import { BalanceTransactionType } from "@prisma/client";
import { IsEnum, IsNumber, IsString, IsPositive, Max, MaxLength, MinLength } from "class-validator";

export class BalanceTransactionDto {
  @ApiProperty({ enum: BalanceTransactionType })
  @IsEnum(BalanceTransactionType)
  type!: BalanceTransactionType;

  @ApiProperty({ example: 100 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(1000000)
  amount!: number;

  @ApiProperty({ example: "Monthly account funding" })
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
