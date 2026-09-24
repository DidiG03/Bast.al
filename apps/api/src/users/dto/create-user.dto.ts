import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";
import { Role } from "@prisma/client";
import { ApiProperty } from "@nestjs/swagger";

const CREATABLE = [Role.OWNER, Role.MANAGER, Role.PLAYER] as const;

export class CreateUserDto {
  @ApiProperty({ example: "manager_01", description: "Public display / sign-in username (no email)" })
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message: "username may only contain letters, numbers, and underscores",
  })
  username!: string;

  @ApiProperty({ enum: CREATABLE })
  @IsIn(CREATABLE)
  role!: (typeof CREATABLE)[number];

  @ApiProperty({
    minLength: 10,
    description: "Initial password; share out-of-band (never shown again in the UI)",
  })
  @IsString()
  @MinLength(10)
  password!: string;

  @ApiProperty({ required: false, description: "Manager id for assigning a Player under an existing Manager" })
  @IsOptional()
  @IsString()
  parentId?: string;
}
