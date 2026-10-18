import type { SlotSymbol } from "../lib/api";

/**
 * The casino slot's symbol pictures, drawn in code in the classic fruit
 * machine look: glossy, lit from the top left, each with a bright highlight,
 * a soft light round its far edge, and a heavy dark outline with a thin light
 * line round it, on the near-black reel. No image files, so there's nothing to license or load. The pictures
 * are shapes, not emoji: phones draw emoji in a canvas unreliably (iPhone
 * Safari leaves big ones blank), and they'd look different on every phone.
 * The 7 is a shape too, not a letter, so it's the same with every font.
 * Each is drawn once per size and kept.
 */

/** Draws a picture in a 100 × 100 box. */
type Icon = (ctx: CanvasRenderingContext2D) => void;
/** `plate`: a red square behind the picture (the star). */
type Look = { icon: Icon; glints: Array<[number, number, number]>; glow?: string; plate?: boolean };

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
  ctx.globalAlpha = 0.6;
  ctx.fillStyle = light;
  ctx.fillRect(cx - r * 1.6, cy - r * 1.6, r * 3.2, r * 3.2);
  ctx.globalAlpha = 1;
}

/** The highlight: a soft white oval, and a small sharp spot in it. */
function highlight(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, turn: number, strength = 0.6) {
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
  ctx.fillStyle = `rgba(255,255,255,${Math.min(1, strength * 1.1)})`;
  ctx.beginPath();
  ctx.ellipse(-rx * 0.12, -rx * 0.05, rx * 0.26, rx * 0.16, 0, 0, Math.PI * 2);
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
    [0.42, "#f98400"],
    [0.78, "#b84400"],
    [1, "#5a1c00"],
  ], "rgba(255,180,80,0.6)", () => {
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
  ctx.rotate(-0.36);
  const body = () => {
    ctx.beginPath();
    ctx.ellipse(0, 0, 47, 30, 0, 0, Math.PI * 2);
  };
  body();
  ctx.fillStyle = ballFill(ctx, 0, 0, 44, [
    [0, "#cdbcff"],
    [0.14, "#6c4fd6"],
    [0.42, "#3a1e9e"],
    [0.78, "#1c0a5e"],
    [1, "#08022a"],
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
  highlight(ctx, -16, -14, 16, 7, -0.15);
  // A short stalk at its right end.
  stalk(ctx, () => {
    ctx.moveTo(44, -4);
    ctx.quadraticCurveTo(49, -6, 53, -11);
  }, 3.2, "#7a5a1c", "rgba(230,200,120,0.8)");
  ctx.restore();
};

const GRAPE: Array<[number, string]> = [
  [0, "#d8e2ff"],
  [0.15, "#6f8cf0"],
  [0.45, "#2c43b8"],
  [0.8, "#121d6e"],
  [1, "#050a30"],
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
  leaf(ctx, 54, 19, -1.25, 30, 0.5);
  leaf(ctx, 58, 20, -0.3, 30, 0.5);
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
    rim(ctx, x, y, r, "rgba(150,180,255,0.65)");
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
  ctx.moveTo(9, 7);
  ctx.lineTo(91, 7);
  ctx.lineTo(91, 27);
  ctx.bezierCurveTo(75, 45, 65, 66, 62, 93);
  ctx.lineTo(31, 93);
  ctx.bezierCurveTo(34, 68, 46, 48, 61, 31);
  ctx.lineTo(28, 31);
  ctx.lineTo(26, 39);
  ctx.lineTo(9, 39);
  ctx.closePath();
}

const seven: Icon = (ctx) => {
  // A red 7 lit to yellow, in a heavy black outline, standing out from a dark red block behind it.
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
  ctx.lineWidth = 9;
  ctx.strokeStyle = INK;
  ctx.lineJoin = "round";
  ctx.stroke();
  // Red, lit to orange and yellow across from the top left.
  const face = ctx.createLinearGradient(18, 8, 78, 92);
  face.addColorStop(0, "#ffd04a");
  face.addColorStop(0.22, "#ff8a12");
  face.addColorStop(0.5, "#ec2a0c");
  face.addColorStop(0.8, "#b8060a");
  face.addColorStop(1, "#6a0004");
  ctx.fillStyle = face;
  ctx.fill();
  // Gloss on the top half, and a lit inner edge.
  ctx.save();
  sevenPath(ctx);
  ctx.clip();
  const gloss = ctx.createLinearGradient(0, 7, 0, 40);
  gloss.addColorStop(0, "rgba(255,255,255,0.5)");
  gloss.addColorStop(0.5, "rgba(255,255,255,0.15)");
  gloss.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gloss;
  ctx.fillRect(0, 7, 100, 33);
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
  PLUM: { icon: plum, glints: [[40, 33, 6]] },
  ORANGE: { icon: orange, glints: [] },
  LEMON: { icon: lemon, glints: [] },
  CHERRY: { icon: cherry, glints: [] },
  STAR: { icon: star, glints: [[50, 52, 10]], plate: true },
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

/** The symbol's picture alone, `size` pixels square on a transparent background, or null for a symbol this game doesn't have. */
const arts = new Map<string, HTMLCanvasElement | null>();
const BOX = 0.9;

function artOf(symbol: SlotSymbol, size: number): HTMLCanvasElement | null {
  const key = `${symbol}:${size}`;
  if (arts.has(key)) return arts.get(key)!;
  const look: Look | undefined = LOOKS[symbol];
  let art: HTMLCanvasElement | null = null;
  if (look) {
    art = document.createElement("canvas");
    art.width = size;
    art.height = size;
    const ctx = art.getContext("2d", { willReadFrequently: true })!;
    const box = size * BOX;
    ctx.translate((size - box) / 2, (size - box) / 2);
    ctx.scale(box / 100, box / 100);
    look.icon(ctx);
  }
  arts.set(key, art);
  return art;
}

/** The star's red square: a bevelled plate, lighter at the top, in a dark edge. */
function plate(ctx: CanvasRenderingContext2D, size: number) {
  const side = size * 0.72;
  const x = (size - side) / 2;
  const y = (size - side) / 2 + size * 0.02;
  ctx.fillStyle = "#1a0000";
  ctx.fillRect(x - size * 0.012, y - size * 0.012, side + size * 0.024, side + size * 0.024);
  const red = ctx.createLinearGradient(0, y, 0, y + side);
  red.addColorStop(0, "#ff3a26");
  red.addColorStop(0.5, "#d8120a");
  red.addColorStop(1, "#8e0604");
  ctx.fillStyle = red;
  ctx.fillRect(x, y, side, side);
  ctx.strokeStyle = "rgba(255,170,150,0.55)";
  ctx.lineWidth = size * 0.01;
  ctx.strokeRect(x + size * 0.012, y + size * 0.012, side - size * 0.024, side - size * 0.024);
}

/** The reel behind a symbol: near black, with a hint of dark blue at the top. */
function reelBackground(ctx: CanvasRenderingContext2D, size: number) {
  const reel = ctx.createLinearGradient(0, 0, 0, size);
  reel.addColorStop(0, "#0c1446");
  reel.addColorStop(0.4, "#050818");
  reel.addColorStop(1, "#010103");
  ctx.fillStyle = reel;
  ctx.fillRect(0, 0, size, size);
}

/**
 * A square picture of a symbol, `size` pixels across: the symbol big on the
 * near-black reel, in a heavy dark outline with a thin light line round it.
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
  reelBackground(ctx, size);

  // A symbol this game doesn't have (from an older game's spin) is left blank rather than breaking the page.
  const look: Look | undefined = LOOKS[symbol];
  const art = artOf(symbol, size);
  if (look && art) {
    if (look.plate) plate(ctx, size);
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
    // A thin light line round a heavy dark one.
    border(ctx, silhouette(art, "#d9dbe6"), size * 0.03);
    border(ctx, shadow, size * 0.017);
    ctx.drawImage(art, 0, 0);
    const box = size * BOX;
    ctx.save();
    ctx.translate((size - box) / 2, (size - box) / 2);
    ctx.scale(box / 100, box / 100);
    for (const [x, y, r] of look.glints) sparkle(ctx, x, y, r);
    ctx.restore();
  }
  drawn.set(key, canvas);
  return canvas;
}

/** How many pictures a burning symbol's flames go through; they loop without a jump. */
export const BURN_FRAMES = 10;

/** Smooth random values on a grid (value noise): the same `seed` always gives the same pattern. */
function noise(seed: number) {
  const hash = (x: number, y: number) => {
    let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const ease = (t: number) => t * t * (3 - 2 * t);
  const at = (x: number, y: number) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = ease(x - x0);
    const fy = ease(y - y0);
    const top = hash(x0, y0) + (hash(x0 + 1, y0) - hash(x0, y0)) * fx;
    const bottom = hash(x0, y0 + 1) + (hash(x0 + 1, y0 + 1) - hash(x0, y0 + 1)) * fx;
    return top + (bottom - top) * fy;
  };
  // Three layers, each finer and fainter: soft billows with ragged detail.
  return (x: number, y: number) => at(x, y) * 0.55 + at(x * 2.1, y * 2.1) * 0.3 + at(x * 4.3, y * 4.3) * 0.15;
}

const flameNoise = noise(7);
const streakNoise = noise(31);

/** Fire's colours by heat (0 to 1): nothing, then deep red, orange, yellow and white-hot at the core. */
const FIRE: Array<[number, number, number, number, number]> = [
  [0.12, 120, 10, 0, 0],
  [0.25, 200, 30, 0, 0.55],
  [0.42, 245, 90, 0, 0.88],
  [0.6, 255, 160, 10, 0.97],
  [0.8, 255, 225, 70, 1],
  [1, 255, 252, 215, 1],
];

function fireColor(heat: number): [number, number, number, number] {
  if (heat <= FIRE[0][0]) return [0, 0, 0, 0];
  for (let i = 1; i < FIRE.length; i += 1) {
    if (heat <= FIRE[i][0]) {
      const [h0, r0, g0, b0, a0] = FIRE[i - 1];
      const [h1, r1, g1, b1, a1] = FIRE[i];
      const t = (heat - h0) / (h1 - h0);
      return [r0 + (r1 - r0) * t, g0 + (g1 - g0) * t, b0 + (b1 - b0) * t, a0 + (a1 - a0) * t];
    }
  }
  const last = FIRE[FIRE.length - 1];
  return [last[1], last[2], last[3], last[4]];
}

/** The fire's two layers, worked out at half size: soft enough not to need more, and four times quicker. */
type FireLayers = { behind: HTMLCanvasElement; over: HTMLCanvasElement };
const fires = new Map<string, FireLayers>();

/**
 * Flames rising off a picture, frame `frame` of BURN_FRAMES: `behind` licks up
 * from its top and sides, `over` is streaks of fire across the picture itself.
 * The noise scrolls upward, and each frame blends two copies a loop apart, so
 * the last frame runs straight into the first.
 */
function fireOf(symbol: SlotSymbol, art: HTMLCanvasElement, frame: number): FireLayers {
  const key = `${symbol}:${art.width}:${frame}`;
  const known = fires.get(key);
  if (known) return known;
  const size = Math.max(16, Math.round(art.width / 2));
  const small = document.createElement("canvas");
  small.width = size;
  small.height = size;
  const smallCtx = small.getContext("2d", { willReadFrequently: true })!;
  smallCtx.drawImage(art, 0, 0, size, size);
  const alpha = smallCtx.getImageData(0, 0, size, size).data;
  const solid = (x: number, y: number) => alpha[(y * size + x) * 4 + 3] > 100;

  // Where the flames start in each column: just inside the top of the picture, spread a little sideways so the
  // sloping sides burn too.
  const top = new Array<number>(size).fill(Infinity);
  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y < size; y += 1) {
      if (solid(x, y)) {
        top[x] = y;
        break;
      }
    }
  }
  const reach = Math.round(size * 0.07);
  const source = top.map((_, x) => {
    let best = Infinity;
    for (let dx = -reach; dx <= reach; dx += 1) {
      const y = top[x + dx];
      if (y !== undefined && y !== Infinity) best = Math.min(best, y + Math.abs(dx) * 1.4);
    }
    return best + size * 0.06;
  });

  const loop = 3;
  const t = (frame / BURN_FRAMES) * loop;
  const blend = frame / BURN_FRAMES;
  const sample = (field: (x: number, y: number) => number, x: number, y: number) =>
    field(x, y + t) * (1 - blend) + field(x, y + t - loop) * blend;
  const height = size * 0.56;

  const behind = new ImageData(size, size);
  const over = new ImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      // A sideways wobble, so the tongues sway and curl as they rise.
      const sway = (sample(flameNoise, u * 2 + 9, v * 2) - 0.5) * 1.1;
      const n = sample(flameNoise, u * 7 + sway, v * 3.2);
      const i = (y * size + x) * 4;
      const rise = source[x] - y;
      if (rise >= 0 && source[x] !== Infinity) {
        // Hottest at the base, cooling as it rises; the noise decides how far each tongue gets.
        // Squaring the noise keeps most columns low and lets a few shoot up: separate tongues, not a wall.
        const reachUp = height * (0.18 + n * n * 1.7);
        const heat = Math.max(0, 1 - rise / reachUp) * (0.65 + n * 0.6);
        const [r, g, b, a] = fireColor(Math.min(1, heat));
        behind.data.set([r, g, b, a * 255], i);
      } else if (solid(x, y)) {
        // On the picture: thin bright streaks, strongest near the top.
        const depth = Math.min(1, (y - source[x]) / (size * 0.55));
        const streak = sample(streakNoise, u * 9 + sway, v * 3.5);
        const heat = Math.max(0, (streak - 0.5) * 2.4) * (1 - depth * 0.85);
        const [r, g, b, a] = fireColor(Math.min(1, 0.15 + heat));
        over.data.set([r, g, b, a * 255 * 0.75], i);
      }
    }
  }
  const layer = (data: ImageData) => {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    canvas.getContext("2d", { willReadFrequently: true })!.putImageData(data, 0, 0);
    return canvas;
  };
  const layers = { behind: layer(behind), over: layer(over) };
  fires.set(key, layers);
  return layers;
}

/** Works out a burning symbol's fire for one frame ahead of time (the slow part of drawBurning), without drawing it. */
export function warmBurning(symbol: SlotSymbol, size: number, frame: number) {
  const art = artOf(symbol, size);
  if (art) fireOf(symbol, art, frame);
}

const burning = new Map<string, HTMLCanvasElement>();

/**
 * A winning symbol on fire, `size` pixels square: the picture glowing yellow
 * to red with a white-hot edge, fire across it and flames rising off it, frame
 * `frame` of BURN_FRAMES. `lit`: on a red cell (a line won across every reel).
 */
export function drawBurning(symbol: SlotSymbol, size: number, frame: number, lit: boolean): HTMLCanvasElement {
  const key = `${symbol}:${size}:${frame}:${lit}`;
  const cached = burning.get(key);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  if (lit) {
    const red = ctx.createLinearGradient(0, 0, 0, size);
    red.addColorStop(0, "#ff3b1c");
    red.addColorStop(0.5, "#e8170b");
    red.addColorStop(1, "#b80c05");
    ctx.fillStyle = red;
    ctx.fillRect(0, 0, size, size);
  } else {
    reelBackground(ctx, size);
  }
  const art = artOf(symbol, size);
  if (art) {
    if (LOOKS[symbol]?.plate) plate(ctx, size);
    const fire = fireOf(symbol, art, frame);
    // The heat round it: an orange glow, the flames behind, then a white-hot edge.
    ctx.save();
    ctx.shadowColor = "rgba(255,140,0,0.9)";
    ctx.shadowBlur = size * 0.09;
    ctx.drawImage(silhouette(art, "#ff7a00"), 0, 0);
    ctx.restore();
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(fire.behind, 0, 0, size, size);
    border(ctx, silhouette(art, "#fff4c8"), size * 0.022);
    border(ctx, silhouette(art, "#1a0400"), size * 0.01);
    // The picture, glowing: a hot yellow-to-red wash over it that still lets its own colour show.
    const hot = document.createElement("canvas");
    hot.width = size;
    hot.height = size;
    const hotCtx = hot.getContext("2d", { willReadFrequently: true })!;
    hotCtx.drawImage(art, 0, 0);
    hotCtx.globalCompositeOperation = "source-atop";
    hotCtx.globalAlpha = 0.3;
    const wash = hotCtx.createRadialGradient(size * 0.44, size * 0.42, size * 0.02, size * 0.5, size * 0.5, size * 0.5);
    wash.addColorStop(0, "#fffbe0");
    wash.addColorStop(0.3, "#ffd21a");
    wash.addColorStop(0.65, "#ff8a00");
    wash.addColorStop(1, "#d42a00");
    hotCtx.fillStyle = wash;
    hotCtx.fillRect(0, 0, size, size);
    ctx.drawImage(hot, 0, 0);
    // Fire across the picture, added as light, and the flames' roots over its top edge.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(fire.over, 0, 0, size, size);
    ctx.globalAlpha = 0.35;
    ctx.drawImage(fire.behind, 0, 0, size, size);
    ctx.restore();
  }
  burning.set(key, canvas);
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
