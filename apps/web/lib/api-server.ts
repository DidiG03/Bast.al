import { headers } from "next/headers";
import { apiFetch } from "./api";
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
