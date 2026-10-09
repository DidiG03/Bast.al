import type { SlotSymbol } from "../lib/api";

/**
 * The casino slot's symbol pictures, drawn in code: big fruit, sevens and a
 * star on the dark reel, outlined in black with a white border. No image files, so there's nothing to license or
 * load. The pictures are shapes, not emoji: phones draw emoji in a canvas
 * unreliably (iPhone Safari leaves big ones blank), and they'd look different
 * on every phone. Each is drawn once per size and kept.
 */

/** Draws a picture in a 100 × 100 box. */
type Icon = (ctx: CanvasRenderingContext2D) => void;
type Look = { icon: Icon; glints: Array<[number, number, number]> };

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

/** A round fruit with a shine: plum, orange. */
function fruit(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, light: string, dark: string) {
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  const fill = ctx.createRadialGradient(cx - rx * 0.35, cy - ry * 0.4, rx * 0.1, cx, cy, Math.max(rx, ry));
  fill.addColorStop(0, light);
  fill.addColorStop(1, dark);
  paint(ctx, fill, 3);
}

function shine(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number) {
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, -0.5, 0, Math.PI * 2);
  ctx.fill();
}

function leaf(ctx: CanvasRenderingContext2D, x: number, y: number, turn: number, length = 26) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(turn);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(length / 2, -length / 2.6, length, 0);
  ctx.quadraticCurveTo(length / 2, length / 2.6, 0, 0);
  paint(ctx, gradient(ctx, -10, 10, ["#8fe36b", "#2f8f2a"]), 2);
  ctx.restore();
}

const cherry: Icon = (ctx) => {
  ctx.lineCap = "round";
  ctx.strokeStyle = "#3d6b1f";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(30, 66);
  ctx.quadraticCurveTo(40, 30, 62, 12);
  ctx.moveTo(70, 70);
  ctx.quadraticCurveTo(66, 36, 62, 12);
  ctx.stroke();
  leaf(ctx, 62, 13, -0.35, 28);
  for (const [x, y] of [[28, 72], [72, 74]]) {
    fruit(ctx, x, y, 23, 22, "#ff6b6b", "#9b0d16");
    shine(ctx, x - 8, y - 8, 4.5, 8);
  }
};

const lemon: Icon = (ctx) => {
  // Tilted, with a pointed nub at each end, a pitted peel that turns orange
  // underneath, and a soft orange shading "smile".
  ctx.save();
  ctx.translate(50, 52);
  ctx.rotate(-0.42);
  const outline = () => {
    ctx.beginPath();
    ctx.moveTo(-50, 3);
    ctx.quadraticCurveTo(-47, -3, -41, -5);
    ctx.bezierCurveTo(-33, -38, 30, -40, 41, -9);
    ctx.quadraticCurveTo(47, -9, 51, -3);
    ctx.quadraticCurveTo(47, 4, 41, 6);
    ctx.bezierCurveTo(31, 39, -30, 41, -41, 10);
    ctx.quadraticCurveTo(-47, 10, -50, 3);
    ctx.closePath();
  };
  outline();
  const fill = ctx.createRadialGradient(-4, -14, 3, 0, 0, 50);
  fill.addColorStop(0, "#fffbd2");
  fill.addColorStop(0.4, "#ffe43c");
  fill.addColorStop(0.8, "#f8b400");
  fill.addColorStop(1, "#ee8a00");
  paint(ctx, fill, 3.5);

  ctx.save();
  outline();
  ctx.clip();
  // Orange underneath.
  const under = ctx.createLinearGradient(0, -10, 0, 40);
  under.addColorStop(0, "rgba(240, 120, 0, 0)");
  under.addColorStop(1, "rgba(240, 110, 0, 0.45)");
  ctx.fillStyle = under;
  ctx.fillRect(-52, -42, 104, 84);
  // Peel pores, in a fixed pattern so every lemon looks the same.
  ctx.fillStyle = "rgba(190, 110, 0, 0.28)";
  for (let i = 0; i < 46; i += 1) {
    const x = -38 + ((i * 37) % 76);
    const y = -28 + ((i * 23) % 58);
    ctx.beginPath();
    ctx.arc(x, y, 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // The shading smile: a wide soft stroke under a narrow stronger one.
  ctx.lineCap = "round";
  for (const [width, alpha] of [[10, 0.22], [4.5, 0.6]] as const) {
    ctx.strokeStyle = `rgba(230, 95, 0, ${alpha})`;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(-30, 16);
    ctx.quadraticCurveTo(0, 34, 32, 12);
    ctx.stroke();
  }
  ctx.restore();
};

const orange: Icon = (ctx) => {
  ctx.beginPath();
  ctx.ellipse(50, 52, 44, 42, 0, 0, Math.PI * 2);
  const fill = ctx.createRadialGradient(36, 34, 4, 50, 52, 48);
  fill.addColorStop(0, "#ffd9a0");
  fill.addColorStop(0.35, "#ffa23a");
  fill.addColorStop(1, "#e85d04");
  paint(ctx, fill, 3);
  // Peel: a red shading streak low down, and pores.
  ctx.strokeStyle = "rgba(200, 40, 10, 0.7)";
  ctx.lineWidth = 3.5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(24, 70);
  ctx.quadraticCurveTo(48, 86, 76, 68);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(70, 40);
  ctx.quadraticCurveTo(80, 52, 76, 62);
  ctx.stroke();
  ctx.fillStyle = "rgba(160, 60, 0, 0.3)";
  for (const [x, y] of [[30, 56], [42, 66], [58, 60], [66, 74], [38, 44], [62, 46], [50, 78], [26, 42]]) {
    ctx.beginPath();
    ctx.arc(x, y, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  // The stalk end.
  ctx.fillStyle = "#6b8e23";
  ctx.beginPath();
  ctx.arc(54, 14, 3, 0, Math.PI * 2);
  ctx.fill();
};

const plum: Icon = (ctx) => {
  // Lying on its side, tilted, with the stalk at the end.
  ctx.save();
  ctx.translate(48, 54);
  ctx.rotate(-0.42);
  ctx.beginPath();
  ctx.ellipse(0, 0, 46, 32, 0, 0, Math.PI * 2);
  const fill = ctx.createRadialGradient(-14, -14, 4, 0, 0, 50);
  fill.addColorStop(0, "#a98bff");
  fill.addColorStop(0.45, "#5a2bd6");
  fill.addColorStop(1, "#2a0c7a");
  paint(ctx, fill, 3);
  ctx.strokeStyle = "rgba(20, 0, 60, 0.5)";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(-40, 6);
  ctx.quadraticCurveTo(0, 22, 42, 4);
  ctx.stroke();
  ctx.strokeStyle = "#7a4a12";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(44, -4);
  ctx.lineTo(54, -8);
  ctx.stroke();
  ctx.restore();
};

const grapes: Icon = (ctx) => {
  // A tilted bunch: big glossy berries overlapping, front ones lower down,
  // with leaves and a curly tendril at the stalk.
  ctx.save();
  ctx.translate(48, 58);
  ctx.rotate(0.45);
  ctx.scale(0.76, 0.76);

  leaf(ctx, 4, -44, -2.4, 30);
  leaf(ctx, 6, -46, -0.6, 32);
  leaf(ctx, 2, -42, -1.5, 26);
  ctx.strokeStyle = "#3d8a2a";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(10, -48);
  ctx.bezierCurveTo(22, -60, 34, -52, 28, -44);
  ctx.bezierCurveTo(24, -40, 20, -46, 25, -48);
  ctx.stroke();

  const berries = [
    [-22, -30], [2, -34], [26, -28],
    [-30, -8], [-5, -11], [20, -6],
    [-18, 12], [7, 10], [30, 14],
    [-8, 31], [17, 30],
    [4, 48],
  ];
  for (const [x, y] of berries) {
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    const fill = ctx.createRadialGradient(x - 5, y - 6, 1, x, y, 15);
    fill.addColorStop(0, "#a9c3ff");
    fill.addColorStop(0.45, "#3d63e0");
    fill.addColorStop(1, "#13207a");
    paint(ctx, fill, 2.5);
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.beginPath();
    ctx.ellipse(x - 5, y - 6, 3.2, 2.2, -0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
};

const melon: Icon = (ctx) => {
  // Half a watermelon seen at an angle: the cut face on the left, the
  // striped rind curving away to the right.
  const rind = () => {
    ctx.beginPath();
    ctx.moveTo(34, 8);
    ctx.bezierCurveTo(70, 2, 98, 30, 97, 58);
    ctx.bezierCurveTo(96, 86, 70, 100, 38, 96);
    ctx.lineTo(34, 8);
    ctx.closePath();
  };
  rind();
  const green = ctx.createRadialGradient(62, 40, 6, 62, 54, 52);
  green.addColorStop(0, "#a8ec7a");
  green.addColorStop(0.55, "#4cb233");
  green.addColorStop(1, "#1d6a17");
  paint(ctx, green, 3.5);
  ctx.save();
  rind();
  ctx.clip();
  // Dark stripes that bend round the rind and meet at its ends, a little jagged.
  ctx.strokeStyle = "#0f4d10";
  ctx.lineWidth = 6;
  ctx.lineJoin = "round";
  for (const bow of [20, 34, 48]) {
    ctx.beginPath();
    for (let step = 0; step <= 16; step += 1) {
      const t = step / 16;
      const jag = step % 2 === 0 ? -1.8 : 1.8;
      ctx.lineTo(44 + Math.sin(t * Math.PI) * bow + jag, 6 + t * 90);
    }
    ctx.stroke();
  }
  ctx.restore();

  // The cut face: a pale ring, then the flesh.
  ctx.beginPath();
  ctx.ellipse(36, 52, 28, 44, -0.06, 0, Math.PI * 2);
  paint(ctx, gradient(ctx, 8, 96, ["#f4fbd8", "#d9eeb0"]), 3.5);
  ctx.beginPath();
  ctx.ellipse(36, 52, 23.5, 38.5, -0.06, 0, Math.PI * 2);
  const flesh = ctx.createRadialGradient(30, 40, 3, 36, 52, 40);
  flesh.addColorStop(0, "#ffb3a8");
  flesh.addColorStop(0.4, "#f2584d");
  flesh.addColorStop(1, "#c41f22");
  ctx.fillStyle = flesh;
  ctx.fill();
  // A deeper red ring just inside the edge, and a little texture.
  ctx.strokeStyle = "rgba(160, 15, 20, 0.55)";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.ellipse(36, 52, 20, 34, -0.06, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "rgba(190, 30, 30, 0.35)";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  for (const [x1, y1, x2, y2] of [[28, 58, 34, 66], [40, 36, 44, 44], [26, 44, 30, 50], [42, 62, 40, 72], [34, 74, 38, 80]]) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.fillStyle = "#3a0a06";
  for (const [x, y] of [[44, 32], [24, 62], [46, 56], [32, 78], [22, 40]]) {
    ctx.beginPath();
    ctx.ellipse(x, y, 1.4, 2.4, 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
};

const seven: Icon = (ctx) => {
  // A bold slanted 7 with a dark 3D edge under a yellow-to-red face.
  ctx.save();
  ctx.translate(50, 54);
  ctx.transform(1, 0, -0.18, 1, 0, 0);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `900 118px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
  ctx.lineJoin = "round";
  ctx.fillStyle = "#4a0000";
  for (let step = 1; step <= 7; step += 1) ctx.fillText("7", step, step);
  ctx.lineWidth = 7;
  ctx.strokeStyle = INK;
  ctx.strokeText("7", 7, 7);
  ctx.strokeText("7", 0, 0);
  const face = ctx.createLinearGradient(0, -50, 0, 50);
  face.addColorStop(0, "#ffd21f");
  face.addColorStop(0.45, "#ff6a00");
  face.addColorStop(1, "#d10a0a");
  ctx.fillStyle = face;
  ctx.fillText("7", 0, 0);
  ctx.restore();
};

const star: Icon = (ctx) => {
  // A faceted gold star: each point has a light and a dark side.
  const points = Array.from({ length: 10 }, (_, i) => {
    const radius = i % 2 === 0 ? 48 : 21;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    return [50 + radius * Math.cos(angle), 54 + radius * Math.sin(angle)] as const;
  });
  ctx.beginPath();
  points.forEach(([x, y]) => ctx.lineTo(x, y));
  ctx.closePath();
  ctx.lineJoin = "round";
  paint(ctx, gradient(ctx, 6, 100, ["#fff3a0", "#f5c518", "#b97a00"]), 3.5);
  for (let i = 0; i < 10; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % 10];
    ctx.beginPath();
    ctx.moveTo(50, 54);
    ctx.lineTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.closePath();
    ctx.fillStyle = i % 2 === 0 ? "rgba(255,255,255,0.28)" : "rgba(120,60,0,0.28)";
    ctx.fill();
  }
  ctx.strokeStyle = "rgba(90,50,0,0.6)";
  ctx.lineWidth = 1.5;
  for (const [x, y] of points) {
    ctx.beginPath();
    ctx.moveTo(50, 54);
    ctx.lineTo(x, y);
    ctx.stroke();
  }
};

/** A white four-point glint, like light catching a shiny fruit. */
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

/** Each picture, and where its glints go (in its 100 × 100 box). */
const LOOKS: Record<SlotSymbol, Look> = {
  SEVEN: { icon: seven, glints: [[66, 18, 10]] },
  MELON: { icon: melon, glints: [[28, 34, 12], [92, 64, 7]] },
  GRAPES: { icon: grapes, glints: [[40, 44, 11]] },
  PLUM: { icon: plum, glints: [[36, 38, 11]] },
  ORANGE: { icon: orange, glints: [[40, 34, 12]] },
  LEMON: { icon: lemon, glints: [[46, 40, 12]] },
  CHERRY: { icon: cherry, glints: [[20, 62, 9], [64, 64, 9]] },
  STAR: { icon: star, glints: [[50, 28, 9]] },
}

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
 * dark reel, with a black outline and a white border round it, like a sticker.
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

  // The reel behind it.
  const reel = ctx.createLinearGradient(0, 0, size, 0);
  reel.addColorStop(0, "#0d0d2e");
  reel.addColorStop(0.5, "#17174a");
  reel.addColorStop(1, "#0d0d2e");
  ctx.fillStyle = reel;
  ctx.fillRect(0, 0, size, size);

  // A symbol this game doesn't have (from an older game's spin) is left blank rather than breaking the page.
  const look: Look | undefined = LOOKS[symbol];
  if (look) {
    const art = document.createElement("canvas");
    art.width = size;
    art.height = size;
    const artCtx = art.getContext("2d", { willReadFrequently: true })!;
    const box = size * 0.84;
    artCtx.translate((size - box) / 2, (size - box) / 2);
    artCtx.scale(box / 100, box / 100);
    look.icon(artCtx);
    border(ctx, silhouette(art, "#ffffff"), size * 0.045);
    border(ctx, silhouette(art, "#000000"), size * 0.022);
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
