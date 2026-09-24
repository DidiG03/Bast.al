import { IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message: "username may only contain letters, numbers, and underscores",
  })
  username?: string;

  @IsOptional()
  @IsString()
  @MinLength(10)
  password?: string;
}
