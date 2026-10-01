import type { SlotSymbol } from "../lib/api";

/**
 * The casino slot's symbol pictures, drawn in code: a tile per symbol with a
 * football picture on it. No image files, so there's nothing to license or
 * load. The pictures are shapes, not emoji: phones draw emoji in a canvas
 * unreliably (iPhone Safari leaves big ones blank), and they'd look different
 * on every phone. Each is drawn once per size and kept.
 */

/** Draws a picture in a 100 × 100 box. */
type Icon = (ctx: CanvasRenderingContext2D) => void;
type Look = { icon?: Icon; label?: string; card?: string; tile: [string, string]; ring: string };

const INK = "#15191e";

function gradient(ctx: CanvasRenderingContext2D, y0: number, y1: number, stops: string[]): CanvasGradient {
  const fill = ctx.createLinearGradient(0, y0, 0, y1);
  stops.forEach((color, index) => fill.addColorStop(index / (stops.length - 1), color));
  return fill;
}

/** Fills and outlines the current path. */
function paint(ctx: CanvasRenderingContext2D, fill: string | CanvasGradient, line = 2.5) {
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = line;
  ctx.strokeStyle = INK;
  ctx.stroke();
}

function shape(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string | CanvasGradient, line = 2.5) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  paint(ctx, fill, line);
}

function polygon(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, sides: number, turn = -Math.PI / 2) {
  ctx.beginPath();
  for (let i = 0; i < sides; i += 1) {
    const angle = turn + (i * 2 * Math.PI) / sides;
    ctx.lineTo(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
  }
  ctx.closePath();
}

const ball: Icon = (ctx) => {
  ctx.beginPath();
  ctx.arc(50, 50, 44, 0, Math.PI * 2);
  const shine = ctx.createRadialGradient(38, 34, 6, 50, 50, 46);
  shine.addColorStop(0, "#ffffff");
  shine.addColorStop(1, "#c3ccd4");
  paint(ctx, shine, 3);
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.5;
  for (let i = 0; i < 5; i += 1) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    ctx.beginPath();
    ctx.moveTo(50 + 14 * Math.cos(angle), 50 + 14 * Math.sin(angle));
    ctx.lineTo(50 + 34 * Math.cos(angle), 50 + 34 * Math.sin(angle));
    ctx.stroke();
    polygon(ctx, 50 + 44 * Math.cos(angle), 50 + 44 * Math.sin(angle), 12, 5, angle + Math.PI);
    ctx.fillStyle = INK;
    ctx.fill();
  }
  ctx.restore();
  polygon(ctx, 50, 50, 15, 5);
  ctx.fillStyle = INK;
  ctx.fill();
};

const trophy: Icon = (ctx) => {
  const gold = gradient(ctx, 10, 95, ["#fff1a6", "#f2bf3a", "#a8700e"]);
  ctx.lineCap = "round";
  for (const side of [1, -1]) {
    // A handle each side.
    ctx.beginPath();
    ctx.moveTo(50 - side * 23, 22);
    ctx.bezierCurveTo(50 - side * 42, 22, 50 - side * 42, 46, 50 - side * 17, 50);
    ctx.lineWidth = 9;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.lineWidth = 5;
    ctx.strokeStyle = gold;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(24, 12);
  ctx.lineTo(76, 12);
  ctx.lineTo(74, 30);
  ctx.bezierCurveTo(72, 52, 62, 61, 50, 63);
  ctx.bezierCurveTo(38, 61, 28, 52, 26, 30);
  ctx.closePath();
  paint(ctx, gold);
  shape(ctx, 45, 62, 10, 14, 2, gold);
  shape(ctx, 33, 74, 34, 8, 2, gold);
  shape(ctx, 26, 82, 48, 10, 3, gradient(ctx, 82, 92, ["#6b4a1e", "#3b2508"]));
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.beginPath();
  ctx.ellipse(38, 28, 4, 11, -0.2, 0, Math.PI * 2);
  ctx.fill();
};

const boot: Icon = (ctx) => {
  ctx.beginPath();
  ctx.moveTo(14, 28);
  ctx.lineTo(40, 28);
  ctx.bezierCurveTo(46, 40, 56, 46, 70, 49);
  ctx.bezierCurveTo(86, 52, 94, 58, 91, 67);
  ctx.lineTo(89, 72);
  ctx.lineTo(16, 72);
  ctx.bezierCurveTo(10, 72, 8, 64, 10, 56);
  ctx.closePath();
  paint(ctx, gradient(ctx, 28, 72, ["#ffffff", "#aebdcc"]), 3);
  // Stripes, laces, sole and studs.
  ctx.beginPath();
  ctx.moveTo(22, 40);
  ctx.lineTo(31, 66);
  ctx.lineTo(38, 66);
  ctx.lineTo(29, 40);
  ctx.closePath();
  ctx.fillStyle = "#ffcc33";
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  for (const [x, y] of [[45, 35], [52, 40], [59, 44]]) {
    ctx.beginPath();
    ctx.moveTo(x - 3, y + 4);
    ctx.lineTo(x + 4, y - 3);
    ctx.stroke();
  }
  shape(ctx, 12, 70, 81, 7, 3, INK, 0);
  for (const x of [20, 34, 62, 77]) shape(ctx, x, 76, 6, 8, 1.5, INK, 0);
};

const gloves: Icon = (ctx) => {
  const green = gradient(ctx, 6, 74, ["#d8ff8f", "#5cc94a"]);
  shape(ctx, 29, 14, 10, 36, 5, green);
  shape(ctx, 40, 8, 10, 42, 5, green);
  shape(ctx, 51, 10, 10, 40, 5, green);
  shape(ctx, 62, 17, 10, 33, 5, green);
  ctx.save();
  ctx.translate(30, 56);
  ctx.rotate(-0.75);
  shape(ctx, -26, -6, 28, 12, 6, green);
  ctx.restore();
  shape(ctx, 26, 38, 48, 36, 11, green);
  shape(ctx, 28, 70, 44, 20, 4, gradient(ctx, 70, 90, ["#ffffff", "#c9d2da"]));
  shape(ctx, 28, 77, 44, 5, 0, "#3b8cff", 0);
};

const flag: Icon = (ctx) => {
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath();
  ctx.ellipse(33, 93, 14, 3.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(36, 12);
  ctx.bezierCurveTo(52, 6, 64, 22, 84, 14);
  ctx.lineTo(84, 44);
  ctx.bezierCurveTo(64, 52, 52, 36, 36, 42);
  ctx.closePath();
  paint(ctx, gradient(ctx, 8, 50, ["#ff6b5e", "#b51f17"]));
  shape(ctx, 29, 8, 7, 86, 3.5, gradient(ctx, 8, 94, ["#ffffff", "#b5bec7"]));
};

const star: Icon = (ctx) => {
  ctx.beginPath();
  for (let i = 0; i < 10; i += 1) {
    const radius = i % 2 === 0 ? 46 : 19;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    ctx.lineTo(50 + radius * Math.cos(angle), 54 + radius * Math.sin(angle));
  }
  ctx.closePath();
  ctx.lineJoin = "round";
  paint(ctx, gradient(ctx, 8, 96, ["#fff6b8", "#f5c542", "#d48a12"]), 3);
};

const goal: Icon = (ctx) => {
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = 1.6;
  for (let x = 19; x < 88; x += 8) {
    ctx.beginPath();
    ctx.moveTo(x, 24);
    ctx.lineTo(x, 80);
    ctx.stroke();
  }
  for (let y = 31; y < 80; y += 8) {
    ctx.beginPath();
    ctx.moveTo(12, y);
    ctx.lineTo(88, y);
    ctx.stroke();
  }
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(9, 82);
  ctx.lineTo(9, 20);
  ctx.lineTo(91, 20);
  ctx.lineTo(91, 82);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 11;
  ctx.stroke();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 7;
  ctx.stroke();
};

const LOOKS: Record<SlotSymbol, Look> = {
  SEVEN: { label: "7", tile: ["#7a1d1d", "#3d0b0b"], ring: "#f5c542" },
  TROPHY: { icon: trophy, tile: ["#5b4314", "#2a1e07"], ring: "#e8b83a" },
  BALL: { icon: ball, tile: ["#1f4f3a", "#0d2a1e"], ring: "#5fd39a" },
  BOOT: { icon: boot, tile: ["#1d3d63", "#0c1f36"], ring: "#6ea8ff" },
  GLOVES: { icon: gloves, tile: ["#3f2a63", "#1f1336"], ring: "#b28cff" },
  FLAG: { icon: flag, tile: ["#2c3640", "#151b21"], ring: "#9aa8b4" },
  YELLOW: { card: "#f7d23e", tile: ["#2c3640", "#151b21"], ring: "#9aa8b4" },
  RED: { card: "#e0453a", tile: ["#2c3640", "#151b21"], ring: "#9aa8b4" },
  WILD: { icon: star, label: "WILD", tile: ["#0f5c56", "#06302d"], ring: "#4fe0d2" },
  GOAL: { icon: goal, label: "GOAL", tile: ["#5a1f4f", "#2b0c25"], ring: "#ff7ad9" },
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
  const iconY = look.label && look.icon ? size * 0.43 : size * 0.5;

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
  if (look.icon) {
    const box = size * (look.label ? 0.5 : 0.62);
    ctx.save();
    ctx.translate(size / 2 - box / 2, iconY - box / 2);
    ctx.scale(box / 100, box / 100);
    look.icon(ctx);
    ctx.restore();
  }
  if (look.label) {
    const big = !look.icon;
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
