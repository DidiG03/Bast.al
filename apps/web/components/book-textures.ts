"use client";

import { useEffect, useState } from "react";

/**
 * Book of Ra's surface textures, made once in the browser as small tiling
 * pictures: rough stone for the temple and reels, and blue marble for the
 * title's letters. They stand in for SVG noise filters, which a browser
 * recomputes whenever anything near them is redrawn and which made spins
 * stutter on slower devices.
 */

export type TextureKind = "stone" | "marble";

const SIZE = 256;

/** A seeded random number source, so every tile comes out the same. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fractal noise that tiles: octaves of smoothed random lattices which wrap
 * at the tile's edge. `cells` sets the coarsest lattice; `ridged` folds each
 * octave about its middle, for marble's veins.
 */
function noise(seed: number, cells: number, octaves: number, ridged: boolean): Float32Array {
  const random = seeded(seed);
  const out = new Float32Array(SIZE * SIZE);
  let amplitude = 1;
  let total = 0;
  for (let octave = 0, n = cells; octave < octaves; octave += 1, n *= 2) {
    const lattice = Float32Array.from({ length: n * n }, () => random());
    const at = (x: number, y: number) => lattice[((y + n) % n) * n + ((x + n) % n)];
    const step = SIZE / n;
    for (let y = 0; y < SIZE; y += 1) {
      const gy = y / step;
      const y0 = Math.floor(gy);
      const ty = gy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < SIZE; x += 1) {
        const gx = x / step;
        const x0 = Math.floor(gx);
        const tx = gx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
        const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
        let value = top + (bottom - top) * sy;
        if (ridged) value = Math.abs(value - 0.5) * 2;
        out[y * SIZE + x] += value * amplitude;
      }
    }
    total += amplitude;
    amplitude /= 2;
  }
  for (let i = 0; i < out.length; i += 1) out[i] /= total;
  return out;
}

/** Rough stone: the noise as a height map, lit from the top left like the original's carvings, in warm brown. */
function stone(pixels: Uint8ClampedArray) {
  const height = noise(11, 8, 5, false);
  const h = (x: number, y: number) => height[((y + SIZE) % SIZE) * SIZE + ((x + SIZE) % SIZE)];
  const light = [-0.55, -0.55, 0.63];
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * 9;
      const dy = (h(x, y + 1) - h(x, y - 1)) * 9;
      const length = Math.hypot(dx, dy, 1);
      const shade = Math.max(0, (-dx * light[0] - dy * light[1] + light[2]) / length);
      const i = (y * SIZE + x) * 4;
      pixels[i] = 0x5e * shade * 1.25;
      pixels[i + 1] = 0x3a * shade * 1.25;
      pixels[i + 2] = 0x1a * shade * 1.25;
      pixels[i + 3] = 255;
    }
  }
}

/** Blue marble: veined noise, from deep blue through sky blue to pale cyan. */
function marble(pixels: Uint8ClampedArray) {
  const veins = noise(5, 4, 5, true);
  // Deep blue, lightening to pale sky blue only near the folds: swirling light veins.
  const deep = [6, 34, 120];
  const mid = [22, 96, 210];
  const pale = [110, 196, 255];
  for (let i = 0; i < veins.length; i += 1) {
    const t = (1 - veins[i]) ** 2.8;
    for (let k = 0; k < 3; k += 1) {
      pixels[i * 4 + k] = t < 0.5 ? deep[k] + (mid[k] - deep[k]) * t * 2 : mid[k] + (pale[k] - mid[k]) * (t - 0.5) * 2;
    }
    pixels[i * 4 + 3] = 255;
  }
}

const made = new Map<TextureKind, string>();

/** The texture as an image address, made the first time it's asked for. Browser only. */
export function texture(kind: TextureKind): string {
  const ready = made.get(kind);
  if (ready) return ready;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(SIZE, SIZE);
  (kind === "stone" ? stone : marble)(image.data);
  ctx.putImageData(image, 0, 0);
  const address = canvas.toDataURL("image/png");
  made.set(kind, address);
  return address;
}

/** The texture's image address once it's made (after the first paint), or null until then. */
export function useTexture(kind: TextureKind): string | null {
  const [address, setAddress] = useState<string | null>(() => made.get(kind) ?? null);
  useEffect(() => {
    if (!address) setAddress(texture(kind));
  }, [address, kind]);
  return address;
}
