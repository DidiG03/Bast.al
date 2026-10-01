import type { SlotSymbol } from "../lib/api";

/**
 * The casino slot's symbol pictures, drawn in code: a tile per symbol with a
 * football picture on it. No image files, so there's nothing to license or
 * load. Each is drawn once per size and kept.
 */

type Look = { glyph?: string; label?: string; card?: string; tile: [string, string]; ring: string };

const LOOKS: Record<SlotSymbol, Look> = {
  SEVEN: { label: "7", tile: ["#7a1d1d", "#3d0b0b"], ring: "#f5c542" },
  TROPHY: { glyph: "🏆", tile: ["#5b4314", "#2a1e07"], ring: "#e8b83a" },
  BALL: { glyph: "⚽", tile: ["#1f4f3a", "#0d2a1e"], ring: "#5fd39a" },
  BOOT: { glyph: "👟", tile: ["#1d3d63", "#0c1f36"], ring: "#6ea8ff" },
  GLOVES: { glyph: "🧤", tile: ["#3f2a63", "#1f1336"], ring: "#b28cff" },
  FLAG: { glyph: "🚩", tile: ["#2c3640", "#151b21"], ring: "#9aa8b4" },
  YELLOW: { card: "#f7d23e", tile: ["#2c3640", "#151b21"], ring: "#9aa8b4" },
  RED: { card: "#e0453a", tile: ["#2c3640", "#151b21"], ring: "#9aa8b4" },
  WILD: { glyph: "⭐", label: "WILD", tile: ["#0f5c56", "#06302d"], ring: "#4fe0d2" },
  GOAL: { glyph: "🥅", label: "GOAL", tile: ["#5a1f4f", "#2b0c25"], ring: "#ff7ad9" },
};

const drawn = new Map<string, HTMLCanvasElement>();

/** A square picture of a symbol, `size` pixels across. */
export function drawSymbol(symbol: SlotSymbol, size: number): HTMLCanvasElement {
  const key = `${symbol}:${size}`;
  const cached = drawn.get(key);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const look = LOOKS[symbol];
  const pad = size * 0.04;
  const radius = size * 0.16;

  // The tile.
  const fill = ctx.createLinearGradient(0, 0, 0, size);
  fill.addColorStop(0, look.tile[0]);
  fill.addColorStop(1, look.tile[1]);
  ctx.beginPath();
  ctx.roundRect(pad, pad, size - pad * 2, size - pad * 2, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = size * 0.035;
  ctx.strokeStyle = look.ring;
  ctx.stroke();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const glyphY = look.label && look.glyph ? size * 0.43 : size * 0.52;

  if (look.card) {
    // A referee's card, tilted.
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.rotate(-0.18);
    ctx.beginPath();
    ctx.roundRect(-size * 0.17, -size * 0.25, size * 0.34, size * 0.5, size * 0.04);
    ctx.fillStyle = look.card;
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = size * 0.06;
    ctx.fill();
    ctx.restore();
  }
  if (look.glyph) {
    ctx.font = `${Math.round(size * (look.label ? 0.42 : 0.5))}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    ctx.fillText(look.glyph, size / 2, glyphY);
  }
  if (look.label) {
    const big = !look.glyph;
    ctx.font = `800 ${Math.round(size * (big ? 0.62 : 0.17))}px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
    const textFill = ctx.createLinearGradient(0, size * 0.2, 0, size * 0.85);
    textFill.addColorStop(0, "#fff6c9");
    textFill.addColorStop(1, look.ring);
    ctx.fillStyle = textFill;
    ctx.lineWidth = size * (big ? 0.035 : 0.02);
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    const y = big ? size * 0.54 : size * 0.8;
    ctx.strokeText(look.label, size / 2, y);
    ctx.fillText(look.label, size / 2, y);
  }
  drawn.set(key, canvas);
  return canvas;
}

/** The same picture as an image address, for the rules sheet. */
export function symbolImage(symbol: SlotSymbol, size = 96): string {
  return drawSymbol(symbol, size).toDataURL("image/png");
}
