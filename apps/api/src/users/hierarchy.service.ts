import { Injectable } from "@nestjs/common";
import { Role } from "@prisma/client";
import { PrismaService } from "../prisma.service";
import { Actor } from "../auth/permissions";

/**
 * Subtree checks via recursive CTE.
 *
 * Tradeoff vs a closure table:
 * - CTE: simpler writes (only parent_id), fine for shallow trees (Owner→Manager→Player).
 * - Closure table: O(1)/indexed descendant checks at scale, but every create/move must
 *   maintain extra edges. Prefer CTE until trees grow large or hot paths show latency.
 */
@Injectable()
export class HierarchyService {
  constructor(private readonly prisma: PrismaService) {}

  async getDescendantIds(rootId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH RECURSIVE subtree AS (
        SELECT id FROM users WHERE parent_id = ${rootId}
        UNION ALL
        SELECT u.id FROM users u
        INNER JOIN subtree s ON u.parent_id = s.id
      )
      SELECT id FROM subtree
    `;
    return rows.map((r) => r.id);
  }

  async isInSubtree(actorId: string, targetId: string): Promise<boolean> {
    if (actorId === targetId) return true;
    const rows = await this.prisma.$queryRaw<{ found: boolean }[]>`
      WITH RECURSIVE subtree AS (
        SELECT id FROM users WHERE parent_id = ${actorId}
        UNION ALL
        SELECT u.id FROM users u
        INNER JOIN subtree s ON u.parent_id = s.id
      )
      SELECT EXISTS(SELECT 1 FROM subtree WHERE id = ${targetId}) AS found
    `;
    return Boolean(rows[0]?.found);
  }

  /**
   * Super Admin may act on anyone. Other roles may act on self or descendants only.
   */
  async canActOn(actor: Actor, targetId: string): Promise<boolean> {
    if (actor.role === Role.SUPER_ADMIN) return true;
    return this.isInSubtree(actor.id, targetId);
  }
}
