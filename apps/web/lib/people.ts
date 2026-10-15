import type { MeResponse, UserRow } from "./api";
import { msg } from "./i18n/core";

/** Plain names for each kind of account. */
export const ROLE_NAMES: Record<MeResponse["role"], string> = { SUPER_ADMIN: msg("Super Admin"), OWNER: msg("Owner"), MANAGER: msg("Manager"), PLAYER: msg("Player") };

/** The accounts around one viewer: who is whose, and what the viewer may do to each. */
export type Team = {
  me: MeResponse;
  users: UserRow[];
  byId: Map<string, UserRow>;
};

export function team(me: MeResponse, users: UserRow[]): Team {
  return { me, users, byId: new Map(users.map((user) => [user.id, user])) };
}

/** Blocked because someone above them is: suspending an account locks out everyone under it. */
export function lockedByAncestor(people: Team, user: UserRow): boolean {
  let parent = user.parentId ? people.byId.get(user.parentId) : undefined;
  while (parent) {
    if (parent.status === "SUSPENDED") return true;
    parent = parent.parentId ? people.byId.get(parent.parentId) : undefined;
  }
  return false;
}

/** Can't sign in: blocked themselves, or someone above them is. */
export function isBlocked(people: Team, user: UserRow): boolean {
  return user.status === "SUSPENDED" || lockedByAncestor(people, user);
}

/** Money goes to and comes back from the people right under you only (Super Admin: the Owners). */
export function isDirect(people: Team, user: UserRow): boolean {
  return user.parentId === people.me.id;
}

/** The Owner whose team an account is in (an Owner is their own). */
export function ownerOf(people: Team, user: UserRow): UserRow | undefined {
  let current: UserRow | undefined = user;
  while (current && current.role !== "OWNER") current = current.parentId ? people.byId.get(current.parentId) : undefined;
  return current;
}

/** Giving credit: to someone right under you who can use it. */
export function canGiveCredit(people: Team, user: UserRow): boolean {
  return user.id !== people.me.id && user.role !== "SUPER_ADMIN" && isDirect(people, user) && !isBlocked(people, user);
}

/** Taking credit back: from someone right under you, blocked or not. */
export function canTakeBack(people: Team, user: UserRow): boolean {
  return user.id !== people.me.id && user.parentId === people.me.id && Number(user.balance) > 0;
}

/** Moving a Player to another Manager: Owners and Super Admin. */
export function canMove(people: Team, user: UserRow): boolean {
  return user.role === "PLAYER" && (people.me.role === "OWNER" || people.me.role === "SUPER_ADMIN");
}

/** The people right under an account. */
export function childrenOf(people: Team, id: string): UserRow[] {
  return people.users.filter((user) => user.parentId === id);
}

/**
 * Where a Player can be moved: an active Manager, or the Owner, of the same
 * team. An Owner sees only their own team anyway; Super Admin sees every
 * team, and a Player never changes team by being moved.
 */
export function moveDestinations(people: Team, player?: UserRow): UserRow[] {
  const owner = player ? ownerOf(people, player) : undefined;
  return people.users.filter(
    (user) => (user.role === "MANAGER" || user.role === "OWNER") && user.status === "ACTIVE" && (!owner || (user.role === "OWNER" ? user.id === owner.id : user.parentId === owner.id)),
  );
}

/** The kinds of account the viewer can add. */
export function creatableRoles(role: MeResponse["role"]): Array<"OWNER" | "MANAGER" | "PLAYER"> {
  return role === "SUPER_ADMIN" ? ["OWNER"] : role === "OWNER" ? ["PLAYER", "MANAGER"] : role === "MANAGER" ? ["PLAYER"] : [];
}
