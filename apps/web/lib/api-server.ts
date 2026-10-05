import { headers } from "next/headers";
import { cache } from "react";
import { apiFetch, type MeResponse } from "./api";
import { signedClientHeaders } from "./client-signature";

/**
 * apiFetch for server components. It calls the API straight from this web
 * server, so on its own the API would see this server's address for every
 * visitor at once; the signed visitor details make rate limits, lockouts and
 * sign-in history apply to the person who opened the page.
 */
export function serverApiFetch<T>(path: string, token: string, init?: RequestInit & { idempotencyKey?: string }): Promise<T> {
  return apiFetch<T>(path, token, {
    ...init,
    headers: { ...signedClientHeaders(headers()), ...((init?.headers as Record<string, string> | undefined) ?? {}) },
  });
}

/**
 * The signed-in account, asked for once per page load: the dashboard's layout
 * and its page both need it, and React's `cache` lets them share one call.
 */
export const getMe = cache((token: string) => serverApiFetch<MeResponse>("/users/me", token));
