import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma.service";

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(input: {
    actorId?: string | null;
    action: string;
    targetId?: string | null;
    ipAddress?: string | null;
    metadata?: Prisma.InputJsonValue;
  }) {
    return this.prisma.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        action: input.action,
        targetId: input.targetId ?? null,
        ipAddress: input.ipAddress ?? null,
        metadata: input.metadata ?? undefined,
      },
    });
  }
}
