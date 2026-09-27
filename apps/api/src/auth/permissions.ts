import { Role, User, UserStatus } from "@prisma/client";

export type Actor = User;

export const ROLE_RANK: Record<Role, number> = {
  SUPER_ADMIN: 4,
  OWNER: 3,
  MANAGER: 2,
  PLAYER: 1,
};

/** Who may create which roles (hierarchy-aware creation matrix). */
export const CREATABLE_ROLES: Record<Role, Role[]> = {
  SUPER_ADMIN: [Role.OWNER],
  OWNER: [Role.MANAGER, Role.PLAYER],
  MANAGER: [Role.PLAYER],
  PLAYER: [],
};

export function canCreateRole(actorRole: Role, targetRole: Role): boolean {
  return CREATABLE_ROLES[actorRole].includes(targetRole);
}

/**
 * Delegation (giving credit down the hierarchy) is only ever allowed between
 * a user and their direct child — never further down the subtree. An Owner
 * delegates to the Managers/Players they created directly; a Manager
 * delegates only to their own Players. Reuses the creation matrix since
 * "who I may delegate to" and "who I may create" are the same relationship.
 */
export function canDelegateTo(
  giver: Pick<User, "id" | "role">,
  receiver: Pick<User, "parentId" | "role">,
): boolean {
  return receiver.parentId === giver.id && canCreateRole(giver.role, receiver.role);
}

export function roleRequiresMfa(role: Role): boolean {
  return role === Role.SUPER_ADMIN || role === Role.OWNER;
}

export function mfaOptional(role: Role): boolean {
  return role === Role.MANAGER;
}

export function isActive(user: Pick<User, "status">): boolean {
  return user.status === UserStatus.ACTIVE;
}
