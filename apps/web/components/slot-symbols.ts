import type { SlotSymbol } from "../lib/api";

/**
 * The casino slot's symbol pictures, drawn in code in the classic fruit
 * machine look: glossy, lit from the top left, each with a bright highlight,
 * a soft light round its far edge and a thin dark outline, on the dark blue
 * reel. No image files, so there's nothing to license or load. The pictures
 * are shapes, not emoji: phones draw emoji in a canvas unreliably (iPhone
 * Safari leaves big ones blank), and they'd look different on every phone.
 * The 7 is a shape too, not a letter, so it's the same with every font.
 * Each is drawn once per size and kept.
 */

/** Draws a picture in a 100 × 100 box. */
type Icon = (ctx: CanvasRenderingContext2D) => void;
type Look = { icon: Icon; glints: Array<[number, number, number]>; glow?: string };

const INK = "#14060a";

/** A fixed random sequence, so every lemon's peel looks the same. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** A shiny ball's colour: lightest where the light hits (top left), darkest at the far edge. */
function ballFill(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, stops: Array<[number, string]>) {
  const fill = ctx.createRadialGradient(cx - r * 0.38, cy - r * 0.42, r * 0.04, cx - r * 0.08, cy - r * 0.08, r * 1.12);
  for (const [at, color] of stops) fill.addColorStop(at, color);
  return fill;
}

/** Light bouncing back onto the far, bottom-right edge. Draw inside a clip to the shape. */
function rim(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  const light = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.95, cx - r * 0.3, cy - r * 0.3, r * 1.45);
  light.addColorStop(0, "rgba(0,0,0,0)");
  light.addColorStop(1, color);
  ctx.fillStyle = light;
  ctx.fillRect(cx - r * 1.6, cy - r * 1.6, r * 3.2, r * 3.2);
}

/** The highlight: a soft white oval, and a small sharp spot in it. */
function highlight(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, turn: number, strength = 0.9) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(turn);
  ctx.scale(1, ry / rx);
  const soft = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  soft.addColorStop(0, `rgba(255,255,255,${strength})`);
  soft.addColorStop(0.45, `rgba(255,255,255,${strength * 0.45})`);
  soft.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = soft;
  ctx.beginPath();
  ctx.arc(0, 0, rx, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.ellipse(-rx * 0.12, -rx * 0.05, rx * 0.32, rx * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Pitted peel: each pit a dark dot with a lit edge. Draw inside a clip to the fruit. */
function pits(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, count: number, dark: string, light: string, seed: number) {
  const random = seeded(seed);
  for (let i = 0; i < count; i += 1) {
    const x = x0 + random() * (x1 - x0);
    const y = y0 + random() * (y1 - y0);
    const r = 0.7 + random() * 0.7;
    ctx.fillStyle = light;
    ctx.beginPath();
    ctx.arc(x + 0.5, y + 0.5, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function outline(ctx: CanvasRenderingContext2D, width = 1.8) {
  ctx.lineWidth = width;
  ctx.strokeStyle = INK;
  ctx.lineJoin = "round";
  ctx.stroke();
}

/** A shiny leaf with a centre vein and side veins. */
function leaf(ctx: CanvasRenderingContext2D, x: number, y: number, turn: number, length: number, width = 0.42) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(turn);
  const half = length * width;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(length * 0.25, -half, length * 0.7, -half * 0.9, length, 0);
  ctx.bezierCurveTo(length * 0.7, half * 0.8, length * 0.25, half * 0.9, 0, 0);
  ctx.closePath();
  const fill = ctx.createLinearGradient(0, -half, 0, half);
  fill.addColorStop(0, "#a6ee6a");
  fill.addColorStop(0.45, "#3fae2a");
  fill.addColorStop(1, "#155c12");
  ctx.fillStyle = fill;
  ctx.fill();
  outline(ctx, 1.5);
  ctx.strokeStyle = "rgba(225,255,170,0.5)";
  ctx.lineWidth = 0.9;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(length * 0.06, 0);
  ctx.quadraticCurveTo(length * 0.5, -half * 0.12, length * 0.92, 0);
  for (const at of [0.3, 0.5, 0.7]) {
    ctx.moveTo(length * at, -half * 0.06);
    ctx.lineTo(length * (at + 0.12), -half * 0.55);
    ctx.moveTo(length * at, -half * 0.02);
    ctx.lineTo(length * (at + 0.12), half * 0.5);
  }
  ctx.stroke();
  ctx.restore();
}

/** A round stalk: a dark edge and a lighter middle. */
function stalk(ctx: CanvasRenderingContext2D, draw: () => void, width: number, dark: string, light: string) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  draw();
  ctx.strokeStyle = INK;
  ctx.lineWidth = width + 2.2;
  ctx.stroke();
  ctx.strokeStyle = dark;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.strokeStyle = light;
  ctx.lineWidth = width * 0.4;
  ctx.save();
  ctx.translate(-width * 0.18, -width * 0.18);
  ctx.beginPath();
  draw();
  ctx.stroke();
  ctx.restore();
}

/** A shiny ball of fruit: colour, light off its far edge, a highlight, an outline. */
function ball(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, stops: Array<[number, string]>, rimColor: string, extra?: () => void) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = ballFill(ctx, cx, cy, r, stops);
  ctx.fill();
  ctx.save();
  ctx.clip();
  rim(ctx, cx, cy, r, rimColor);
  extra?.();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  outline(ctx);
  highlight(ctx, cx - r * 0.4, cy - r * 0.42, r * 0.36, r * 0.22, -0.7);
}

const CHERRY_RED: Array<[number, string]> = [
  [0, "#ffb3a6"],
  [0.12, "#ff4a3d"],
  [0.4, "#e3001b"],
  [0.75, "#8e0010"],
  [1, "#3a0006"],
];

const cherry: Icon = (ctx) => {
  const left = { x: 29, y: 68, r: 22 };
  const right = { x: 70, y: 73, r: 23 };
  // Stalks from each cherry up to where they join, under the leaf.
  stalk(ctx, () => {
    ctx.moveTo(left.x + 3, left.y - left.r + 4);
    ctx.bezierCurveTo(36, 36, 48, 20, 62, 11);
    ctx.moveTo(right.x - 1, right.y - right.r + 4);
    ctx.bezierCurveTo(68, 40, 64, 24, 62, 11);
  }, 3.6, "#4e8a1e", "rgba(200,240,120,0.85)");
  leaf(ctx, 62, 11, -0.3, 30, 0.4);
  for (const { x, y, r } of [left, right]) {
    ball(ctx, x, y, r, CHERRY_RED, "rgba(255,90,130,0.75)", () => {
      // The dip where the stalk goes in.
      ctx.strokeStyle = "rgba(70,0,8,0.65)";
      ctx.lineWidth = 2.2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.ellipse(x + 1, y - r + 5, 5.5, 2.4, 0, 0.15, Math.PI - 0.15);
      ctx.stroke();
    });
  }
};

/** The lemon's outline: an oval with a pointed nub at each end. */
function lemonPath(ctx: CanvasRenderingContext2D) {
  ctx.beginPath();
  ctx.moveTo(-50, 3);
  ctx.quadraticCurveTo(-47, -3, -41, -5);
  ctx.bezierCurveTo(-33, -38, 30, -40, 41, -9);
  ctx.quadraticCurveTo(47, -9, 51, -3);
  ctx.quadraticCurveTo(47, 4, 41, 6);
  ctx.bezierCurveTo(31, 39, -30, 41, -41, 10);
  ctx.quadraticCurveTo(-47, 10, -50, 3);
  ctx.closePath();
}

const lemon: Icon = (ctx) => {
  ctx.save();
  ctx.translate(50, 52);
  ctx.rotate(-0.38);
  lemonPath(ctx);
  ctx.fillStyle = ballFill(ctx, 0, 0, 46, [
    [0, "#fffde0"],
    [0.15, "#fff04a"],
    [0.45, "#ffd200"],
    [0.8, "#e08e00"],
    [1, "#9a5600"],
  ]);
  ctx.fill();
  ctx.save();
  lemonPath(ctx);
  ctx.clip();
  // Greener nubs.
  for (const x of [-48, 49]) {
    const nub = ctx.createRadialGradient(x, 0, 0, x, 0, 12);
    nub.addColorStop(0, "rgba(150,170,0,0.55)");
    nub.addColorStop(1, "rgba(150,170,0,0)");
    ctx.fillStyle = nub;
    ctx.fillRect(x - 12, -12, 24, 24);
  }
  pits(ctx, -44, -34, 44, 34, 110, "rgba(180,110,0,0.2)", "rgba(255,255,220,0.3)", 7);
  rim(ctx, 0, 0, 46, "rgba(255,245,170,0.7)");
  ctx.restore();
  lemonPath(ctx);
  outline(ctx, 2);
  highlight(ctx, -14, -17, 17, 7, -0.12);
  ctx.restore();
};

const orange: Icon = (ctx) => {
  const [cx, cy, r] = [50, 53, 43];
  ball(ctx, cx, cy, r, [
    [0, "#fff0cf"],
    [0.12, "#ffbe55"],
    [0.42, "#ff8a00"],
    [0.78, "#cf4f00"],
    [1, "#6a2200"],
  ], "rgba(255,190,90,0.7)", () => {
    pits(ctx, cx - r, cy - r, cx + r, cy + r, 170, "rgba(150,55,0,0.2)", "rgba(255,230,170,0.25)", 21);
    // The dip round the stalk end.
    const dip = ctx.createRadialGradient(cx + 4, cy - r + 6, 0, cx + 4, cy - r + 6, 11);
    dip.addColorStop(0, "rgba(120,40,0,0.55)");
    dip.addColorStop(1, "rgba(120,40,0,0)");
    ctx.fillStyle = dip;
    ctx.fillRect(cx - 10, cy - r - 6, 28, 26);
  });
  // A little green star where the stalk was.
  ctx.save();
  ctx.translate(cx + 4, cy - r + 6);
  ctx.beginPath();
  for (let i = 0; i < 10; i += 1) {
    const reach = i % 2 === 0 ? 6 : 2.4;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    ctx.lineTo(Math.cos(angle) * reach, Math.sin(angle) * reach * 0.55);
  }
  ctx.closePath();
  ctx.fillStyle = "#4f8f1c";
  ctx.fill();
  outline(ctx, 1.2);
  ctx.fillStyle = "#6b4a12";
  ctx.beginPath();
  ctx.arc(0, 0, 1.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
};

const plum: Icon = (ctx) => {
  ctx.save();
  ctx.translate(48, 56);
  ctx.rotate(-0.4);
  const body = () => {
    ctx.beginPath();
    ctx.ellipse(0, 0, 45, 34, 0, 0, Math.PI * 2);
  };
  body();
  ctx.fillStyle = ballFill(ctx, 0, 0, 44, [
    [0, "#e2ccff"],
    [0.14, "#9a6cff"],
    [0.42, "#5c22d6"],
    [0.78, "#2e0a86"],
    [1, "#10023a"],
  ]);
  ctx.fill();
  ctx.save();
  body();
  ctx.clip();
  // The bloom: a faint dusty haze on the skin.
  const bloom = ctx.createRadialGradient(-6, -10, 4, 0, 0, 46);
  bloom.addColorStop(0, "rgba(220,210,255,0.22)");
  bloom.addColorStop(1, "rgba(220,210,255,0)");
  ctx.fillStyle = bloom;
  ctx.fillRect(-50, -40, 100, 80);
  rim(ctx, 0, 0, 40, "rgba(170,130,255,0.75)");
  // The groove along it: a shadow with a lit edge.
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(20,0,60,0.6)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-42, 2);
  ctx.bezierCurveTo(-18, 18, 18, 18, 44, -2);
  ctx.stroke();
  ctx.strokeStyle = "rgba(200,170,255,0.5)";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(-40, -1);
  ctx.bezierCurveTo(-18, 14, 18, 14, 42, -5);
  ctx.stroke();
  ctx.restore();
  body();
  outline(ctx, 2);
  highlight(ctx, -16, -16, 16, 8, -0.2);
  ctx.restore();
  // The stalk and a leaf, at the top-right end.
  stalk(ctx, () => {
    ctx.moveTo(84, 36);
    ctx.quadraticCurveTo(88, 28, 92, 24);
  }, 3.4, "#6e4a16", "rgba(220,180,110,0.8)");
  leaf(ctx, 88, 29, -2.3, 24, 0.42);
};

const GRAPE: Array<[number, string]> = [
  [0, "#f2d6ff"],
  [0.15, "#c06af0"],
  [0.45, "#7d1fb8"],
  [0.8, "#3d0a6a"],
  [1, "#16022c"],
];

const grapes: Icon = (ctx) => {
  // A bunch hanging from the top, the lower berries in front.
  ctx.save();
  ctx.translate(50, 54);
  ctx.scale(0.9, 0.9);
  ctx.translate(-50, -50);
  const berries: Array<[number, number]> = [
    [34, 30], [52, 27], [70, 31],
    [26, 46], [44, 44], [62, 44], [78, 47],
    [34, 61], [52, 60], [70, 62],
    [42, 76], [60, 76],
    [51, 90],
  ];
  // The stalk, then the vine leaf behind the top of the bunch.
  stalk(ctx, () => {
    ctx.moveTo(52, 20);
    ctx.quadraticCurveTo(54, 10, 62, 4);
  }, 3.4, "#6e5a16", "rgba(230,200,120,0.8)");
  leaf(ctx, 50, 18, -2.75, 32, 0.5);
  leaf(ctx, 56, 16, -0.45, 30, 0.5);
  // A curly tendril.
  ctx.strokeStyle = "#4e8a1e";
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(60, 8);
  ctx.bezierCurveTo(72, 0, 82, 8, 76, 14);
  ctx.bezierCurveTo(72, 18, 68, 12, 73, 10);
  ctx.stroke();
  const r = 11.5;
  for (const [x, y] of berries) {
    // A soft shadow on the berries behind.
    const shade = ctx.createRadialGradient(x + 2, y + 3, r * 0.6, x + 2, y + 3, r * 1.45);
    shade.addColorStop(0, "rgba(10,0,20,0.55)");
    shade.addColorStop(1, "rgba(10,0,20,0)");
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.arc(x + 2, y + 3, r * 1.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = ballFill(ctx, x, y, r, GRAPE);
    ctx.fill();
    ctx.save();
    ctx.clip();
    rim(ctx, x, y, r, "rgba(230,150,255,0.7)");
    ctx.restore();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    outline(ctx, 1.4);
    highlight(ctx, x - r * 0.38, y - r * 0.42, r * 0.42, r * 0.26, -0.7, 0.85);
  }
  ctx.restore();
};

const melon: Icon = (ctx) => {
  // A whole watermelon lying tilted, with dark jagged stripes running end to end.
  ctx.save();
  ctx.translate(50, 54);
  ctx.rotate(-0.32);
  const [rx, ry] = [47, 36];
  const body = () => {
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  };
  body();
  ctx.fillStyle = ballFill(ctx, 0, 0, 44, [
    [0, "#e9ffc8"],
    [0.14, "#9be05a"],
    [0.42, "#3f9f25"],
    [0.78, "#1b6413"],
    [1, "#062a06"],
  ]);
  ctx.fill();
  ctx.save();
  body();
  ctx.clip();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const across of [-0.86, -0.52, -0.17, 0.17, 0.52, 0.86]) {
    ctx.beginPath();
    for (let step = 0; step <= 40; step += 1) {
      const t = -1 + (step / 40) * 2;
      const bulge = Math.sqrt(Math.max(0, 1 - t * t));
      const jag = Math.sin(step * 2.1 + across * 9) * 1.6 * bulge;
      ctx.lineTo(t * rx, across * ry * bulge + jag);
    }
    ctx.strokeStyle = "rgba(8,58,10,0.9)";
    ctx.lineWidth = 6.5;
    ctx.stroke();
    ctx.strokeStyle = "rgba(4,36,6,0.6)";
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  rim(ctx, 0, 0, 42, "rgba(190,255,150,0.6)");
  ctx.restore();
  body();
  outline(ctx, 2);
  // The stalk end, and a long shine along the top.
  ctx.fillStyle = "#c9b45a";
  ctx.beginPath();
  ctx.ellipse(-rx + 3, 0, 2.5, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  outline(ctx, 1.2);
  highlight(ctx, -10, -20, 22, 7, -0.05, 0.85);
  ctx.restore();
};

/** The 7, as a shape: a bar with a short leg at its left end, and a slanted stem. */
function sevenPath(ctx: CanvasRenderingContext2D) {
  ctx.beginPath();
  ctx.moveTo(14, 9);
  ctx.lineTo(87, 9);
  ctx.lineTo(87, 24);
  ctx.bezierCurveTo(72, 42, 62, 64, 59, 92);
  ctx.lineTo(35, 92);
  ctx.bezierCurveTo(38, 66, 50, 46, 64, 29);
  ctx.lineTo(31, 29);
  ctx.lineTo(29, 37);
  ctx.lineTo(13, 37);
  ctx.closePath();
}

const seven: Icon = (ctx) => {
  // A red 7 with a gold edge, standing out from a dark red block behind it.
  ctx.save();
  ctx.translate(2, 0);
  for (let step = 6; step >= 1; step -= 1) {
    ctx.save();
    ctx.translate(step * 0.7, step * 0.9);
    sevenPath(ctx);
    ctx.fillStyle = step === 6 ? INK : "#4d0003";
    ctx.fill();
    ctx.restore();
  }
  sevenPath(ctx);
  ctx.lineWidth = 10;
  ctx.strokeStyle = INK;
  ctx.lineJoin = "round";
  ctx.stroke();
  const gold = ctx.createLinearGradient(0, 6, 0, 94);
  gold.addColorStop(0, "#fffbe0");
  gold.addColorStop(0.18, "#ffd53a");
  gold.addColorStop(0.45, "#b97700");
  gold.addColorStop(0.62, "#ffe27a");
  gold.addColorStop(1, "#a26200");
  ctx.lineWidth = 7;
  ctx.strokeStyle = gold;
  ctx.stroke();
  const face = ctx.createLinearGradient(0, 9, 0, 92);
  face.addColorStop(0, "#ff8a72");
  face.addColorStop(0.2, "#ff2a1a");
  face.addColorStop(0.6, "#d0000c");
  face.addColorStop(1, "#6a0004");
  ctx.fillStyle = face;
  ctx.fill();
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = "rgba(60,0,0,0.8)";
  ctx.stroke();
  // Gloss on the top half, and a lit inner edge.
  ctx.save();
  sevenPath(ctx);
  ctx.clip();
  const gloss = ctx.createLinearGradient(0, 9, 0, 40);
  gloss.addColorStop(0, "rgba(255,255,255,0.75)");
  gloss.addColorStop(0.5, "rgba(255,255,255,0.25)");
  gloss.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gloss;
  ctx.fillRect(0, 9, 100, 31);
  ctx.translate(1.2, 1.4);
  sevenPath(ctx);
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = "rgba(255,170,150,0.55)";
  ctx.stroke();
  ctx.restore();
  ctx.restore();
};

const star: Icon = (ctx) => {
  // A gold star with a light and a dark side to each point. Its glow is drawn on the reel (see LOOKS).
  const [cx, cy] = [50, 53];
  const points = Array.from({ length: 10 }, (_, i) => {
    const radius = i % 2 === 0 ? 48 : 20;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)] as const;
  });
  const shape = () => {
    ctx.beginPath();
    points.forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.closePath();
  };
  shape();
  ctx.lineJoin = "round";
  ctx.lineWidth = 5;
  ctx.strokeStyle = INK;
  ctx.stroke();
  for (let i = 0; i < 10; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % 10];
    // The half of a point on its clockwise side is lit, the other half in shade.
    const lit = i % 2 === 0;
    const tip = lit ? [x1, y1] : [x2, y2];
    const fill = ctx.createLinearGradient(cx, cy, tip[0], tip[1]);
    fill.addColorStop(0, lit ? "#fffbe0" : "#ffcf3a");
    fill.addColorStop(0.55, lit ? "#ffe45c" : "#e09a00");
    fill.addColorStop(1, lit ? "#ffc21a" : "#8c4f00");
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    // Fills the hairline between the halves.
    ctx.strokeStyle = fill;
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }
  shape();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = "#7a4300";
  ctx.stroke();
};

/** A white four-point glint, like light catching something shiny. */
function sparkle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 0.8);
  glow.addColorStop(0, "rgba(255,255,255,0.85)");
  glow.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, r * 0.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.quadraticCurveTo(x, y, x, y + r);
  ctx.quadraticCurveTo(x, y, x - r, y);
  ctx.quadraticCurveTo(x, y, x, y - r);
  ctx.fill();
}

/** Each picture, and where its glints go (in its 100 × 100 box). The fruit shine on their own. */
const LOOKS: Record<SlotSymbol, Look> = {
  SEVEN: { icon: seven, glints: [[78, 14, 9]] },
  MELON: { icon: melon, glints: [] },
  GRAPES: { icon: grapes, glints: [] },
  PLUM: { icon: plum, glints: [] },
  ORANGE: { icon: orange, glints: [] },
  LEMON: { icon: lemon, glints: [] },
  CHERRY: { icon: cherry, glints: [] },
  STAR: { icon: star, glints: [[50, 52, 12]], glow: "255,214,90" },
};

const drawn = new Map<string, HTMLCanvasElement>();

/** `art` filled in one colour: its silhouette. */
function silhouette(art: HTMLCanvasElement, color: string): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = art.width;
  out.height = art.height;
  // On the CPU, like the symbol it goes into (see drawSymbol): copying between GPU and CPU canvases waits on the GPU.
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(art, 0, 0);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, out.width, out.height);
  return out;
}

/** Draws a silhouette all round, `radius` out: a border of that colour around the picture. */
function border(ctx: CanvasRenderingContext2D, shape: HTMLCanvasElement, radius: number) {
  for (const reach of [radius, radius * 0.5]) {
    for (let i = 0; i < 24; i += 1) {
      const angle = (i * Math.PI * 2) / 24;
      ctx.drawImage(shape, Math.cos(angle) * reach, Math.sin(angle) * reach);
    }
  }
}

/**
 * A square picture of a symbol, `size` pixels across: the symbol big on the
 * dark blue reel, with a thin dark edge and a soft shadow under it.
 */
export function drawSymbol(symbol: SlotSymbol, size: number): HTMLCanvasElement {
  const key = `${symbol}:${size}`;
  const cached = drawn.get(key);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  // Drawn on the CPU: the picture is read back (as an image address, or into the reels' textures), and reading a
  // GPU canvas waits for the GPU, which the spinning reels keep busy.
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

  // The reel behind it: dark blue, lighter in the middle, as if lit from the front.
  const reel = ctx.createLinearGradient(0, 0, size, 0);
  reel.addColorStop(0, "#07082a");
  reel.addColorStop(0.5, "#16195a");
  reel.addColorStop(1, "#07082a");
  ctx.fillStyle = reel;
  ctx.fillRect(0, 0, size, size);

  // A symbol this game doesn't have (from an older game's spin) is left blank rather than breaking the page.
  const look: Look | undefined = LOOKS[symbol];
  if (look) {
    const art = document.createElement("canvas");
    art.width = size;
    art.height = size;
    const artCtx = art.getContext("2d", { willReadFrequently: true })!;
    const box = size * 0.9;
    artCtx.translate((size - box) / 2, (size - box) / 2);
    artCtx.scale(box / 100, box / 100);
    look.icon(artCtx);
    if (look.glow) {
      const glow = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size * 0.5);
      glow.addColorStop(0, `rgba(${look.glow},0.6)`);
      glow.addColorStop(0.5, `rgba(${look.glow},0.2)`);
      glow.addColorStop(1, `rgba(${look.glow},0)`);
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, size, size);
    }
    // A soft shadow under the picture, then a thin dark edge round it.
    const shadow = silhouette(art, "#000000");
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = size * 0.05;
    ctx.shadowOffsetX = size * 0.012;
    ctx.shadowOffsetY = size * 0.025;
    ctx.drawImage(shadow, 0, 0);
    ctx.restore();
    border(ctx, shadow, size * 0.012);
    ctx.drawImage(art, 0, 0);
    ctx.save();
    ctx.translate((size - box) / 2, (size - box) / 2);
    ctx.scale(box / 100, box / 100);
    for (const [x, y, r] of look.glints) sparkle(ctx, x, y, r);
    ctx.restore();
  }
  drawn.set(key, canvas);
  return canvas;
}

const addresses = new Map<string, string>();

/**
 * The same picture as an image address, for the rules sheet and the list of
 * wins. Made once: the page draws these again on every update, and encoding
 * the picture each time held up the spin.
 */
export function symbolImage(symbol: SlotSymbol, size = 96): string {
  const key = `${symbol}:${size}`;
  let address = addresses.get(key);
  if (!address) {
    address = drawSymbol(symbol, size).toDataURL("image/png");
    addresses.set(key, address);
  }
  return address;
}
