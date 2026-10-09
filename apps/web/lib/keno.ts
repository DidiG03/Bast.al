/**
 * Keno in the browser: the same draw as the API's (apps/api/src/casino/keno.ts),
 * so a Player can check any round from its seeds once the server seed is
 * shown. The API makes every draw and pays it; this file never draws one.
 */

export const NUMBERS = 80;
export const DRAWN = 20;

/** The 20 numbers these seeds and this nonce draw, in order: the i-th is HMAC-SHA256(serverSeed, "clientSeed:nonce:i"), first 4 bytes as a fraction, times the numbers left in the pot. */
export async function drawFromSeeds(serverSeed: string, clientSeed: string, nonce: number): Promise<number[]> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(serverSeed), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const pot = Array.from({ length: NUMBERS }, (_, index) => index + 1);
  const drawn: number[] = [];
  for (let i = 0; i < DRAWN; i++) {
    const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${clientSeed}:${nonce}:${i}`)));
    const fraction = bytes[0] / 256 + bytes[1] / 256 ** 2 + bytes[2] / 256 ** 3 + bytes[3] / 256 ** 4;
    drawn.push(pot.splice(Math.floor(fraction * pot.length), 1)[0]);
  }
  return drawn;
}

/** n numbers from 1 to 80, all different, for a quick pick. Looks only: the draw doesn't depend on them. */
export function quickPick(count: number): number[] {
  const pot = Array.from({ length: NUMBERS }, (_, index) => index + 1);
  const picks: number[] = [];
  const random = new Uint32Array(count);
  crypto.getRandomValues(random);
  for (let i = 0; i < count; i++) picks.push(pot.splice(random[i] % pot.length, 1)[0]);
  return picks.sort((a, b) => a - b);
}

/** A multiplier as the pay table shows it: 3.6 → "3.6×", 2000 → "2,000×". */
export const times = (multiplier: number) => `${multiplier.toLocaleString("en-US", { maximumFractionDigits: 1 })}×`;
