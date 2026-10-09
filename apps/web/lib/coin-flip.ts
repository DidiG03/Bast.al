/**
 * Coin Flip in the browser: the same flip as the API's
 * (apps/api/src/casino/coin-flip.ts), so a Player can check any flip from its
 * seeds once the server seed is shown. The API makes every flip and pays it;
 * this file never flips one.
 */

import type { CoinSide } from "./api";

/** The side these seeds and this nonce show: HMAC-SHA256(serverSeed, "clientSeed:nonce"), first 4 bytes as a fraction; below 0.5 is heads. */
export async function flipFromSeeds(serverSeed: string, clientSeed: string, nonce: number): Promise<CoinSide> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(serverSeed), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${clientSeed}:${nonce}`)));
  const fraction = bytes[0] / 256 + bytes[1] / 256 ** 2 + bytes[2] / 256 ** 3 + bytes[3] / 256 ** 4;
  return fraction < 0.5 ? "HEADS" : "TAILS";
}
