import { IsDateString, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { Type } from "class-transformer";
import { BalanceTransactionStatus } from "@prisma/client";

/** Which money moves the Money page lists. */
export const MONEY_KINDS = ["transfers", "given", "taken", "corrections", "bets", "casino", "all"] as const;
export type MoneyKind = (typeof MONEY_KINDS)[number];

export class MoneyQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsIn(MONEY_KINDS)
  kind?: MoneyKind;

  @IsOptional()
  @IsIn(Object.values(BalanceTransactionStatus))
  status?: BalanceTransactionStatus;

  /** Only moves to or from this person (someone in your team). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  person?: string;

  /** "me": moves you made; "others": moves made by the people under you (or the system). */
  @IsOptional()
  @IsIn(["me", "others"])
  by?: "me" | "others";

  /** Part of a username: the sender, the receiver or whoever made the move. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  @Min(1)
  page?: number;
}
