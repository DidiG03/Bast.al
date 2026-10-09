import type { BookSymbol } from "../lib/api";

/**
 * Book of Ra's symbol pictures. Each one can come from an image in
 * public/casino/book-of-ra/, listed in that folder's manifest.json (for
 * example "EXPLORER": "explorer.webp"); a symbol with no image there is
 * drawn here in code instead, after the original: the pharaoh's gold bust
 * against a red hood, the winged goddess on her plinth, the turquoise scarab
 * in a gold cartouche, card letters made of glowing tubes, the explorer and
 * the book, on a transparent background so the stone reel shows through. So
 * the game is complete without any image, and pictures can be swapped in
 * without changing code. Each is drawn once per size and kept.
 */

const ART_FOLDER = "/casino/book-of-ra";

/** Draws a picture in a 100 × 100 box. */
type Icon = (ctx: CanvasRenderingContext2D) => void;

/** A point on a stroke's centre line and the stroke's width there. */
type Knot = [x: number, y: number, width: number];

const GOLD = ["#fff2b8", "#f6cc5a", "#c98e24", "#7a4a0c"];

function linear(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, stops: string[]): CanvasGradient {
  const fill = ctx.createLinearGradient(x0, y0, x1, y1);
  stops.forEach((color, index) => fill.addColorStop(index / (stops.length - 1), color));
  return fill;
}

const vertical = (ctx: CanvasRenderingContext2D, y0: number, y1: number, stops: string[]) => linear(ctx, 0, y0, 0, y1, stops);

function radial(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, stops: string[], fx = x, fy = y): CanvasGradient {
  const fill = ctx.createRadialGradient(fx, fy, 0, x, y, r);
  stops.forEach((color, index) => fill.addColorStop(index / (stops.length - 1), color));
  return fill;
}

/** A soft glow of `color` around whatever is drawn next; `blur` is in the 100-box's units. */
function glow(ctx: CanvasRenderingContext2D, color: string, blur: number) {
  ctx.shadowColor = color;
  ctx.shadowBlur = blur * ctx.getTransform().a;
}

/** A smooth curve through the knots (Catmull-Rom), as closely spaced knots with the width eased between them. */
function sample(knots: Knot[], closed = false): Knot[] {
  const count = knots.length;
  const at = (i: number) => (closed ? knots[(i + count) % count] : knots[Math.max(0, Math.min(count - 1, i))]);
  const out: Knot[] = [];
  const spans = closed ? count : count - 1;
  for (let i = 0; i < spans; i += 1) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const steps = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 0.35));
    for (let s = 0; s < steps; s += 1) {
      const t = s / steps;
      const point = [0, 1, 2].map(
        (k) =>
          0.5 * (2 * p1[k] + (p2[k] - p0[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t * t + (3 * p1[k] - p0[k] - 3 * p2[k] + p3[k]) * t * t * t),
      );
      out.push(point as Knot);
    }
  }
  if (!closed) out.push(knots[count - 1]);
  return out;
}

/** Points round an ellipse, as knots of one width, for a closed stroke. */
function ring(x: number, y: number, rx: number, ry: number, width: number, tilt = 0): Knot[] {
  return Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2;
    const [dx, dy] = [Math.cos(a) * rx, Math.sin(a) * ry];
    return [x + dx * Math.cos(tilt) - dy * Math.sin(tilt), y + dx * Math.sin(tilt) + dy * Math.cos(tilt), width];
  });
}

/** Fills every stroke at `share` of its width: a brush run along the curves. */
function brush(ctx: CanvasRenderingContext2D, strokes: Knot[][], share: number, fill: string | CanvasGradient) {
  ctx.beginPath();
  for (const stroke of strokes) {
    for (const [x, y, width] of stroke) {
      const r = (width / 2) * share;
      if (r < 0.05) continue;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
  }
  ctx.fillStyle = fill;
  ctx.fill();
}

/** The colours of a card letter, light to deep, and the faint glow round it. */
type Tint = { light: string; bright: string; mid: string; dark: string; deep: string; halo: string };

/** Every knot of the strokes moved by (dx, dy). */
const shifted = (lines: Knot[][], dx: number, dy: number) => lines.map((line) => line.map(([x, y, w]) => [x + dx, y + dy, w] as Knot));

/** A stadium (a tall oval with straight sides) as knots for a closed stroke: the 0 of the 10. */
function stadium(x: number, top: number, bottom: number, r: number, width: number): Knot[] {
  const arc = (cy: number, from: number) =>
    Array.from({ length: 7 }, (_, i) => {
      const a = from + (i / 6) * Math.PI;
      return [x + Math.cos(a) * r, cy + Math.sin(a) * r, width] as Knot;
    });
  return [...arc(top, Math.PI), [x + r, (top + bottom) / 2, width], ...arc(bottom, 0), [x - r, (top + bottom) / 2, width]];
}

/**
 * A card letter as the original draws them: solid, bevelled strokes of
 * coloured metal — a drop shadow, light along the upper-left edge and shade
 * along the lower-right, and a double line engraved down the middle of each
 * stroke, one dark, one light.
 */
function carved(tint: Tint, ...strokes: { knots: Knot[]; closed?: boolean }[]): Icon {
  return (ctx) => {
    // The original's strokes are heavy: every width a little wider than drawn in the knots.
    const lines = strokes.map(({ knots, closed }) =>
      sample(
        knots.map(([x, y, w]) => [x, y, w * 1.15] as Knot),
        closed,
      ),
    );
    const px = ctx.getTransform().a;
    const body = vertical(ctx, 6, 94, [tint.bright, tint.mid, tint.bright]);
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.8)";
    ctx.shadowBlur = 3 * px;
    ctx.shadowOffsetX = 1.6 * px;
    ctx.shadowOffsetY = 2.4 * px;
    brush(ctx, lines, 1, tint.deep);
    ctx.restore();
    ctx.save();
    glow(ctx, tint.halo, 5);
    brush(ctx, lines, 1, tint.deep);
    ctx.restore();
    brush(ctx, shifted(lines, -0.55, -0.75), 0.9, tint.light);
    brush(ctx, shifted(lines, 0.55, 0.75), 0.9, tint.deep);
    brush(ctx, lines, 0.84, body);
    // The engraved double line.
    brush(ctx, lines, 0.5, tint.dark);
    brush(ctx, lines, 0.42, body);
    brush(ctx, shifted(lines, -0.2, -0.2), 0.26, tint.light);
    brush(ctx, lines, 0.19, body);
  };
}

const QUEEN = carved(
  { light: "#d8ffd0", bright: "#4ee85a", mid: "#16a02e", dark: "#055a14", deep: "#012a06", halo: "rgba(40,230,80,0.4)" },
  { knots: ring(48, 41, 33, 30, 10, -0.05), closed: true },
  {
    knots: [
      [20, 54, 6.5],
      [48, 53, 7],
      [76, 52, 6.5],
    ],
  },
  {
    knots: [
      [42, 69, 9],
      [42, 76, 9],
      [48, 81, 8.5],
      [60, 80, 8],
      [71, 78, 7.5],
      [80, 80, 7],
      [79, 86, 5.5],
      [71, 92, 3],
    ],
  },
);

const KING = carved(
  { light: "#ffd2c0", bright: "#ff5a3a", mid: "#cc1c10", dark: "#6a0602", deep: "#2a0000", halo: "rgba(255,60,30,0.4)" },
  {
    knots: [
      [15, 17, 3],
      [24, 15, 8],
      [36, 15, 8.5],
      [46, 17, 4],
    ],
  },
  {
    knots: [
      [30, 15, 12],
      [32, 32, 13],
      [31, 52, 13],
      [29, 68, 11],
      [26, 84, 3],
    ],
  },
  {
    knots: [
      [35, 48, 5],
      [43, 42, 8],
      [50, 32, 9.5],
      [56, 20, 9.5],
      [63, 11, 8],
      [72, 7, 6],
      [80, 8, 4],
      [84, 12, 2],
    ],
  },
  {
    knots: [
      [36, 50, 5],
      [46, 54, 9],
      [55, 63, 10.5],
      [63, 72, 10.5],
      [73, 78, 9],
      [82, 76, 8],
      [86, 70, 7],
    ],
  },
);

const ACE = carved(
  { light: "#ffe8a0", bright: "#ffc23a", mid: "#c8640a", dark: "#6a2a02", deep: "#2a0c00", halo: "rgba(255,150,30,0.4)" },
  {
    knots: [
      [33, 19, 2.5],
      [42, 16, 7],
      [60, 14, 8.5],
      [78, 12, 9],
      [87, 11, 4],
    ],
  },
  {
    knots: [
      [77, 13, 11.5],
      [78, 32, 12.5],
      [79, 55, 12],
      [80, 72, 9],
      [81, 86, 2],
    ],
  },
  {
    knots: [
      [69, 16, 6.5],
      [63, 28, 9],
      [55, 44, 10],
      [46, 58, 10],
      [36, 69, 9.5],
      [26, 75, 9],
      [18, 73, 8],
      [13, 66, 7.5],
      [16, 60, 6],
    ],
  },
  {
    knots: [
      [40, 53, 2.5],
      [46, 49, 6],
      [62, 47, 6.5],
      [77, 45, 6],
    ],
  },
);

const JACK = carved(
  { light: "#d8ecff", bright: "#5aa8ff", mid: "#1a50d8", dark: "#081e70", deep: "#020a30", halo: "rgba(40,120,255,0.4)" },
  {
    knots: [
      [36, 16, 3],
      [46, 14, 8.5],
      [66, 13, 9.5],
      [85, 12, 3.5],
    ],
  },
  {
    knots: [
      [66, 14, 12],
      [66, 32, 13],
      [63, 52, 13],
      [57, 66, 12],
      [47, 75, 11],
      [34, 79, 10],
      [23, 77, 9],
      [17, 71, 7.5],
    ],
  },
  {
    knots: [
      [77, 15, 6],
      [77, 28, 5],
      [75, 42, 1.5],
    ],
  },
);

const TEN = carved(
  { light: "#ffd8f6", bright: "#ff6ae0", mid: "#cc22b0", dark: "#6a0658", deep: "#2a0024", halo: "rgba(255,80,220,0.4)" },
  // The 1: a straight stem with a beak to the left.
  {
    knots: [
      [31, 14, 11],
      [31, 40, 11],
      [31, 66, 11],
      [31, 81, 11],
    ],
  },
  {
    knots: [
      [30, 30, 7],
      [24, 35, 7],
      [18, 40, 5],
    ],
  },
  // The 0, a cartouche: a tall oval standing on a short bar.
  { knots: stadium(65, 27, 55, 14, 9), closed: true },
  {
    knots: [
      [65, 68, 10],
      [65, 78, 10],
    ],
  },
  {
    knots: [
      [47, 78, 6.5],
      [65, 78, 7],
      [83, 78, 6.5],
    ],
  },
);

/** The book of Ra: worn red-brown leather with gold corners, a gold border and a winged scarab, the pages showing at the side. */
const book: Icon = (ctx) => {
  ctx.save();
  glow(ctx, "rgba(255,190,60,0.55)", 10);
  // Pages, then the cover over them.
  ctx.beginPath();
  ctx.moveTo(30, 9);
  ctx.lineTo(88, 12);
  ctx.lineTo(88, 92);
  ctx.lineTo(30, 95);
  ctx.closePath();
  ctx.fillStyle = linear(ctx, 70, 0, 90, 0, ["#f6e7bf", "#d8bd84", "#a8874c"]);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = "rgba(110,70,20,0.5)";
  ctx.lineWidth = 0.6;
  for (let y = 15; y < 91; y += 2.4) {
    ctx.beginPath();
    ctx.moveTo(80, y);
    ctx.lineTo(87.5, y + 0.2);
    ctx.stroke();
  }
  const cover = new Path2D("M12 6 L80 4 Q83 4 83 7 L83 93 Q83 96 80 96 L12 94 Q9 94 9 91 L9 9 Q9 6 12 6 Z");
  ctx.fillStyle = radial(ctx, 42, 40, 62, ["#b8502c", "#8a2c14", "#5a1608", "#2e0a02"], 36, 30);
  ctx.fill(cover);
  ctx.save();
  ctx.clip(cover);
  // Worn leather: soft darker patches.
  for (const [x, y, r] of [
    [22, 78, 14],
    [70, 20, 12],
    [64, 82, 10],
    [18, 22, 9],
  ]) {
    ctx.fillStyle = radial(ctx, x, y, r, ["rgba(40,8,0,0.35)", "rgba(40,8,0,0)"]);
    ctx.fillRect(0, 0, 100, 100);
  }
  ctx.restore();
  ctx.strokeStyle = "rgba(30,6,0,0.8)";
  ctx.lineWidth = 1.2;
  ctx.stroke(cover);
  // Gold border, and the spine's raised bands.
  const gold = linear(ctx, 10, 6, 84, 96, GOLD);
  ctx.strokeStyle = gold;
  ctx.lineWidth = 2;
  ctx.strokeRect(16, 12, 61, 76);
  ctx.lineWidth = 0.8;
  ctx.strokeRect(19.5, 15.5, 54, 69);
  for (const y of [22, 50, 78]) {
    ctx.beginPath();
    ctx.moveTo(9, y);
    ctx.lineTo(14, y);
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
  // Gold corner pieces.
  for (const [x, y, dx, dy] of [
    [9, 6, 1, 1],
    [83, 4, -1, 1],
    [9, 94, 1, -1],
    [83, 96, -1, -1],
  ]) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + dx * 15, y);
    ctx.quadraticCurveTo(x + dx * 6, y + dy * 6, x, y + dy * 15);
    ctx.closePath();
    ctx.fillStyle = gold;
    ctx.fill();
    ctx.strokeStyle = "rgba(70,40,0,0.7)";
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }
  // The winged scarab in the middle, a sun disc above it.
  ctx.save();
  glow(ctx, "rgba(255,200,80,0.6)", 4);
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(46, 47);
    ctx.bezierCurveTo(46 + side * 10, 38, 46 + side * 22, 36, 46 + side * 27, 40);
    ctx.bezierCurveTo(46 + side * 22, 44, 46 + side * 18, 50, 46 + side * 6, 54);
    ctx.closePath();
    ctx.fillStyle = gold;
    ctx.fill();
  }
  ctx.restore();
  ctx.strokeStyle = "rgba(90,40,0,0.7)";
  ctx.lineWidth = 0.6;
  for (const side of [-1, 1]) {
    for (let i = 1; i <= 4; i += 1) {
      ctx.beginPath();
      ctx.moveTo(46 + side * (6 + i * 4), 41 + i * 0.3);
      ctx.lineTo(46 + side * (4 + i * 3.4), 50 - i * 0.4);
      ctx.stroke();
    }
  }
  ctx.beginPath();
  ctx.ellipse(46, 51, 6.5, 9, 0, 0, Math.PI * 2);
  ctx.fillStyle = radial(ctx, 46, 51, 9, ["#fff2b8", "#e2a83a", "#8a5410"], 44, 47);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(46, 40.5, 4, 2.8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(90,40,0,0.8)";
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.moveTo(46, 44);
  ctx.lineTo(46, 59);
  ctx.stroke();
  ctx.save();
  glow(ctx, "rgba(255,60,20,0.8)", 4);
  ctx.beginPath();
  ctx.arc(46, 30, 5, 0, Math.PI * 2);
  ctx.fillStyle = radial(ctx, 46, 30, 5, ["#ffb48a", "#f03a1a", "#9a0c04"], 44.5, 28.5);
  ctx.fill();
  ctx.restore();
  // Hieroglyphs pressed into the gold below.
  ctx.fillStyle = "rgba(246,204,90,0.85)";
  for (let i = 0; i < 6; i += 1) {
    const x = 26 + i * 7.4;
    ctx.fillRect(x, 70, 3.2, 1);
    ctx.fillRect(x + 1, 72.5, 1.2, 4);
    ctx.beginPath();
    ctx.arc(x + 1.6, 79, 1.2, 0, Math.PI * 2);
    ctx.fill();
  }
};

/** The explorer: a weathered face in the shade of a brown fedora, a khaki shirt and a red neckerchief. */
const explorer: Icon = (ctx) => {
  // Shoulders in an open khaki shirt.
  ctx.beginPath();
  ctx.moveTo(8, 100);
  ctx.bezierCurveTo(10, 84, 24, 78, 38, 76);
  ctx.lineTo(62, 76);
  ctx.bezierCurveTo(76, 78, 90, 84, 92, 100);
  ctx.closePath();
  ctx.fillStyle = radial(ctx, 50, 80, 50, ["#d8b47a", "#a07a44", "#5a3e1c"], 40, 76);
  ctx.fill();
  ctx.strokeStyle = "rgba(60,36,10,0.7)";
  ctx.lineWidth = 0.8;
  for (const [x0, x1] of [
    [38, 30],
    [62, 70],
  ]) {
    ctx.beginPath();
    ctx.moveTo(x0, 77);
    ctx.lineTo(x1, 100);
    ctx.stroke();
  }
  // Neck and the red neckerchief.
  ctx.beginPath();
  ctx.moveTo(41, 64);
  ctx.lineTo(59, 64);
  ctx.lineTo(60, 79);
  ctx.lineTo(40, 79);
  ctx.closePath();
  ctx.fillStyle = vertical(ctx, 64, 79, ["#8a5430", "#c08454"]);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(37, 76);
  ctx.quadraticCurveTo(50, 82, 63, 76);
  ctx.lineTo(56, 90);
  ctx.lineTo(50, 86);
  ctx.lineTo(44, 90);
  ctx.closePath();
  ctx.fillStyle = vertical(ctx, 76, 90, ["#e8482c", "#a01a0c", "#5e0a04"]);
  ctx.fill();
  // The face, lit from the left.
  const face = new Path2D("M33 40 C33 30 67 30 67 40 L67 52 C67 62 60 70 50 70 C40 70 33 62 33 52 Z");
  ctx.fillStyle = radial(ctx, 44, 46, 30, ["#f6cfa4", "#d89a66", "#9a5e34", "#5e3418"], 40, 42);
  ctx.fill(face);
  ctx.save();
  ctx.clip(face);
  // Stubble, and the hat's shadow over the brow.
  ctx.fillStyle = "rgba(70,40,20,0.28)";
  ctx.beginPath();
  ctx.ellipse(50, 66, 15, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = vertical(ctx, 36, 48, ["rgba(40,18,4,0.75)", "rgba(40,18,4,0)"]);
  ctx.fillRect(30, 36, 40, 12);
  ctx.restore();
  // Ears.
  for (const x of [32, 68]) {
    ctx.beginPath();
    ctx.ellipse(x, 51, 2.5, 4.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#b8784a";
    ctx.fill();
  }
  // Eyes under strong brows, the nose and a firm mouth.
  for (const [x, flip] of [
    [42.5, -1],
    [57.5, 1],
  ]) {
    ctx.beginPath();
    ctx.ellipse(x, 50, 3.4, 1.7, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#f2e2cc";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, 50, 1.4, 0, Math.PI * 2);
    ctx.fillStyle = "#3a2410";
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - 4.5, 46.5 + flip * 0.6);
    ctx.quadraticCurveTo(x, 44.6, x + 4.5, 46.5 - flip * 0.6);
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = "#3e220e";
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(90,46,20,0.8)";
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(50, 50);
  ctx.quadraticCurveTo(48, 57, 51, 59);
  ctx.moveTo(44.5, 63.5);
  ctx.quadraticCurveTo(50, 65.5, 55.5, 63.5);
  ctx.stroke();
  // The fedora: brim, crown with a pinch, and a dark band.
  ctx.save();
  glow(ctx, "rgba(0,0,0,0.5)", 3);
  ctx.beginPath();
  ctx.moveTo(10, 41);
  ctx.bezierCurveTo(16, 33, 84, 31, 92, 39);
  ctx.bezierCurveTo(88, 46, 72, 41, 50, 41.5);
  ctx.bezierCurveTo(30, 42, 16, 47, 10, 41);
  ctx.fillStyle = vertical(ctx, 32, 46, ["#a8743e", "#6e4620", "#3e240c"]);
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.moveTo(29, 38);
  ctx.bezierCurveTo(27, 22, 33, 8, 44, 10);
  ctx.quadraticCurveTo(50, 13, 56, 10);
  ctx.bezierCurveTo(67, 8, 73, 22, 71, 37);
  ctx.quadraticCurveTo(50, 35, 29, 38);
  ctx.fillStyle = linear(ctx, 28, 10, 72, 38, ["#c08a4e", "#8a5a2a", "#4e2e10"]);
  ctx.fill();
  ctx.strokeStyle = "rgba(50,28,8,0.6)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(50, 13);
  ctx.quadraticCurveTo(49, 20, 50, 28);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(29.3, 31);
  ctx.quadraticCurveTo(50, 28.5, 70.7, 30.5);
  ctx.lineTo(71, 37);
  ctx.quadraticCurveTo(50, 35, 29, 38);
  ctx.closePath();
  ctx.fillStyle = "#2a1606";
  ctx.fill();
};

/** Polished gold, lit from above: bright on top, deep in the middle, a little reflected light at the bottom. */
const METAL = ["#fff6cc", "#f6cf62", "#c88a26", "#7a4608", "#b8801e"];

/** Inlaid beads round part of an ellipse (angles in radians, clockwise from the right), each lit on its upper left. */
function beads(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
  from: number,
  to: number,
  count: number,
  size: number,
  color: string,
) {
  for (let i = 0; i <= count; i += 1) {
    const a = from + ((to - from) * i) / count;
    const [bx, by] = [x + Math.cos(a) * rx, y + Math.sin(a) * ry];
    ctx.beginPath();
    ctx.arc(bx, by, size, 0, Math.PI * 2);
    ctx.fillStyle = radial(ctx, bx, by, size, ["rgba(255,255,255,0.75)", color, "rgba(0,0,0,0.55)"], bx - size * 0.35, by - size * 0.4);
    ctx.fill();
  }
}

/** A band of the broad collar: a strip round the neck in one colour, beaded along it. */
function collarRow(ctx: CanvasRenderingContext2D, y: number, r: number, width: number, color: string, beadColor: string) {
  ctx.beginPath();
  ctx.ellipse(50, y, r, r * 0.62, 0, 0.08, Math.PI - 0.08);
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke();
  beads(ctx, 50, y, r, r * 0.62, 0.12, Math.PI - 0.12, Math.round(r * 1.1), width * 0.36, beadColor);
}

/** Stripes of lapis inlaid in gold across the clip, each band rounded (dark edges, a lit middle) and following the curve of the head. */
function lapisStripes(ctx: CanvasRenderingContext2D, from: number, to: number, step: number, bend: (y: number) => number) {
  for (let y = from; y < to; y += step) {
    const b = bend(y);
    ctx.beginPath();
    ctx.moveTo(0, y + b);
    ctx.quadraticCurveTo(50, y - b, 100, y + b);
    ctx.lineWidth = step * 0.46;
    ctx.strokeStyle = vertical(ctx, y - b - step * 0.25, y - b + step * 0.25, ["#3a5ccc", "#1a2a78", "#070c30"]);
    ctx.stroke();
    // The gold's bright edge along the top of each stripe.
    ctx.beginPath();
    ctx.moveTo(0, y + b - step * 0.3);
    ctx.quadraticCurveTo(50, y - b - step * 0.3, 100, y + b - step * 0.3);
    ctx.lineWidth = 0.45;
    ctx.strokeStyle = "rgba(255,246,204,0.75)";
    ctx.stroke();
  }
}

/** Shades a clipped shape round, like a cylinder lit from the left of centre: dark sides, a highlight. */
function roundShade(ctx: CanvasRenderingContext2D, x0: number, x1: number, strength = 1) {
  ctx.fillStyle = linear(ctx, x0, 0, x1, 0, [
    `rgba(0,0,0,${0.6 * strength})`,
    "rgba(0,0,0,0)",
    `rgba(255,244,200,${0.22 * strength})`,
    "rgba(0,0,0,0)",
    `rgba(0,0,0,${0.65 * strength})`,
  ]);
  ctx.fillRect(x0, 0, x1 - x0, 100);
}

/**
 * The pharaoh, after Tutankhamun's mask: a modelled gold face with inlaid
 * eyes and lapis brows, the striped headdress with lappets falling to the
 * chest, cobra on the brow, plaited beard, a beaded broad collar, and the
 * crook and flail, against a dark hood edged in glowing red.
 */
const pharaoh: Icon = (ctx) => {
  // The hood behind, with folds, edged in glowing red.
  const hood = new Path2D("M50 1 C31 1 20 13 18 30 C15 54 5 72 2 100 L98 100 C95 72 85 54 82 30 C80 13 69 1 50 1 Z");
  ctx.save();
  glow(ctx, "rgba(255,40,10,0.9)", 7);
  ctx.fillStyle = radial(ctx, 50, 62, 56, ["#8a3410", "#5e1a06", "#3a0c02"]);
  ctx.fill(hood);
  ctx.restore();
  ctx.save();
  ctx.clip(hood);
  ctx.strokeStyle = "rgba(20,2,0,0.45)";
  ctx.lineWidth = 2;
  for (const [x0, x1] of [
    [10, 18],
    [90, 82],
    [6, 13],
    [94, 87],
  ]) {
    ctx.beginPath();
    ctx.moveTo(x0, 100);
    ctx.quadraticCurveTo((x0 + x1) / 2 + (x0 < 50 ? -2 : 2), 75, x1, 52);
    ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = "#ff3a14";
  ctx.lineWidth = 1.8;
  ctx.stroke(hood);

  // The headdress behind: crown and the wings flaring to the shoulders.
  const nemes = new Path2D("M50 5 C66 5 74 14 75 28 C77 42 84 54 85 68 L86 100 L14 100 L15 68 C16 54 23 42 25 28 C26 14 34 5 50 5 Z");
  ctx.save();
  glow(ctx, "rgba(255,150,40,0.6)", 4);
  ctx.fillStyle = vertical(ctx, 5, 100, METAL);
  ctx.fill(nemes);
  ctx.restore();
  ctx.save();
  ctx.clip(nemes);
  lapisStripes(ctx, 11, 100, 5.4, (y) => (y < 34 ? 5 : 2));
  roundShade(ctx, 14, 86);
  ctx.fillStyle = vertical(ctx, 74, 100, ["rgba(30,8,0,0)", "rgba(30,8,0,0.6)"]);
  ctx.fillRect(0, 74, 100, 26);
  ctx.restore();

  // Neck and chest, in shadow under the chin.
  ctx.beginPath();
  ctx.moveTo(39, 50);
  ctx.lineTo(61, 50);
  ctx.lineTo(66, 100);
  ctx.lineTo(34, 100);
  ctx.closePath();
  ctx.fillStyle = vertical(ctx, 50, 100, ["#4a2a08", "#a8721e", "#c88e2e"]);
  ctx.fill();

  // The broad collar, row on row of beads: green, gold, turquoise, carnelian, lapis, and gold drops on the edge.
  ctx.save();
  ctx.beginPath();
  ctx.rect(30, 60, 40, 40);
  ctx.clip();
  collarRow(ctx, 62, 9.5, 3, "#1f7a4a", "#4ad48a");
  collarRow(ctx, 62, 12.5, 2.6, "#b8861e", "#ffe08a");
  collarRow(ctx, 62, 15.5, 3, "#178a96", "#5ae0e6");
  collarRow(ctx, 62, 18.5, 2.6, "#9a2a10", "#ff7a4a");
  collarRow(ctx, 62, 21.5, 3, "#1f3a96", "#6a8cff");
  collarRow(ctx, 62, 24.5, 2.4, "#1f7a4a", "#4ad48a");
  for (let i = 0; i <= 16; i += 1) {
    const a = 0.2 + ((Math.PI - 0.4) * i) / 16;
    const [dx, dy] = [50 + Math.cos(a) * 27, 62 + Math.sin(a) * 27 * 0.62];
    ctx.beginPath();
    ctx.ellipse(dx, dy, 1.1, 2, a - Math.PI / 2, 0, Math.PI * 2);
    ctx.fillStyle = radial(ctx, dx, dy, 2, ["#fff2b8", "#d89a2a", "#6a3c08"], dx - 0.4, dy - 0.8);
    ctx.fill();
  }
  ctx.restore();

  // The lappets: striped bands falling in front of the shoulders, either side of the face.
  for (const side of [-1, 1]) {
    const s = (dx: number) => 50 + side * dx;
    const lappet = new Path2D(
      `M${s(13)} 27 C${s(14)} 42 ${s(15)} 54 ${s(17)} 66 L${s(20)} 100 L${s(31)} 100 L${s(27)} 64 C${s(25)} 50 ${s(23)} 38 ${s(22)} 24 Z`,
    );
    ctx.save();
    glow(ctx, "rgba(0,0,0,0.6)", 3);
    ctx.fillStyle = vertical(ctx, 24, 100, METAL);
    ctx.fill(lappet);
    ctx.restore();
    ctx.save();
    ctx.clip(lappet);
    lapisStripes(ctx, 30, 100, 5.4, () => 0.8);
    roundShade(ctx, Math.min(s(13), s(31)), Math.max(s(13), s(31)), 0.8);
    ctx.restore();
    ctx.strokeStyle = "rgba(60,30,0,0.7)";
    ctx.lineWidth = 0.6;
    ctx.stroke(lappet);
  }

  // Ears, set in front of the headdress.
  for (const side of [-1, 1]) {
    const x = 50 + side * 14;
    ctx.beginPath();
    ctx.ellipse(x, 38.5, 2.6, 5, side * 0.15, 0, Math.PI * 2);
    ctx.fillStyle = radial(ctx, x, 38, 5, ["#ffe39a", "#d49a36", "#7a4a0c"], x - side, 36);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(x + side * 0.4, 38.5, 1.2, 3, side * 0.15, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(90,45,0,0.55)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, 42.6, 0.5, 0, Math.PI * 2);
    ctx.fillStyle = "#2a1404";
    ctx.fill();
  }

  // The face: gold, modelled — shadowed sockets and temples, lit forehead, cheekbones and nose.
  const face = new Path2D("M37 25 Q50 20 63 25 C64 33 63.5 41 62 47 C60 54 55.5 58.5 50 59 C44.5 58.5 40 54 38 47 C36.5 41 36 33 37 25 Z");
  ctx.fillStyle = radial(ctx, 50, 38, 24, ["#ffeab0", "#eeb64e", "#b8781e", "#6a3c08"], 49, 33);
  ctx.fill(face);
  ctx.save();
  ctx.clip(face);
  const shade = (x: number, y: number, r: number, color: string) => {
    ctx.fillStyle = radial(ctx, x, y, r, [color, "rgba(0,0,0,0)"]);
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };
  shade(44, 36, 6.5, "rgba(110,52,0,0.55)");
  shade(56, 36, 6.5, "rgba(110,52,0,0.55)");
  shade(37, 40, 7, "rgba(70,30,0,0.6)");
  shade(63, 40, 7, "rgba(70,30,0,0.65)");
  shade(42.5, 45, 5, "rgba(255,246,210,0.45)");
  shade(57.5, 45, 5, "rgba(255,246,210,0.35)");
  shade(50, 28, 7, "rgba(255,248,220,0.5)");
  shade(50, 55.5, 4, "rgba(255,240,200,0.35)");
  shade(46.2, 43, 3, "rgba(110,52,0,0.45)");
  ctx.restore();
  ctx.strokeStyle = "rgba(80,40,0,0.55)";
  ctx.lineWidth = 0.6;
  ctx.stroke(face);

  // Lapis brows, and the eyes: white, dark iris with a glint, kohl lines running to the temples.
  for (const side of [-1, 1]) {
    const x = 50 + side * 6;
    ctx.beginPath();
    ctx.moveTo(50 + side * 1.6, 32.6);
    ctx.quadraticCurveTo(x, 29.6, 50 + side * 11, 32.4);
    ctx.lineTo(50 + side * 11, 33.6);
    ctx.quadraticCurveTo(x, 31, 50 + side * 1.8, 33.8);
    ctx.closePath();
    ctx.fillStyle = vertical(ctx, 30, 34, ["#4a6ad8", "#1a2a78", "#0a1040"]);
    ctx.fill();
    const eye = new Path2D(`M${x - 4} 36.6 Q${x} 33.6 ${x + 4} 36.6 Q${x} 38.8 ${x - 4} 36.6 Z`);
    ctx.fillStyle = vertical(ctx, 34, 38.5, ["#d8ccb0", "#f6f0e0"]);
    ctx.fill(eye);
    ctx.save();
    ctx.clip(eye);
    ctx.beginPath();
    ctx.arc(x + side * 0.3, 36.3, 1.7, 0, Math.PI * 2);
    ctx.fillStyle = radial(ctx, x, 36.3, 1.7, ["#3a2414", "#140a04"]);
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(x + side * 0.3 - 0.5, 35.7, 0.45, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fill();
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = "#0e0a20";
    ctx.stroke(eye);
    ctx.beginPath();
    ctx.moveTo(x + side * 4, 36.6);
    ctx.lineTo(x + side * 7.4, 36.1);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // The nose: a lit ridge, shadowed sides, nostrils.
  ctx.beginPath();
  ctx.moveTo(49.2, 36);
  ctx.quadraticCurveTo(48.4, 42, 47.2, 45.6);
  ctx.quadraticCurveTo(50, 47.6, 52.8, 45.6);
  ctx.quadraticCurveTo(51.6, 42, 50.8, 36);
  ctx.closePath();
  ctx.fillStyle = linear(ctx, 47, 0, 53, 0, ["rgba(120,60,0,0.5)", "rgba(255,240,190,0.55)", "rgba(120,60,0,0.4)"]);
  ctx.fill();
  for (const x of [48.5, 51.5]) {
    ctx.beginPath();
    ctx.ellipse(x, 46.2, 0.9, 0.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#5a2e04";
    ctx.fill();
  }
  // Lips: upper, lower with a highlight, and the line between.
  ctx.beginPath();
  ctx.moveTo(45.6, 50.4);
  ctx.quadraticCurveTo(48, 49, 50, 49.9);
  ctx.quadraticCurveTo(52, 49, 54.4, 50.4);
  ctx.quadraticCurveTo(50, 51.2, 45.6, 50.4);
  ctx.fillStyle = "#a8621a";
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(45.9, 50.6);
  ctx.quadraticCurveTo(50, 54.4, 54.1, 50.6);
  ctx.quadraticCurveTo(50, 51.6, 45.9, 50.6);
  ctx.fillStyle = vertical(ctx, 50.6, 53.6, ["#c47a26", "#e8b052"]);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(45.6, 50.5);
  ctx.quadraticCurveTo(50, 51.5, 54.4, 50.5);
  ctx.lineWidth = 0.6;
  ctx.strokeStyle = "#5a2e04";
  ctx.stroke();

  // The gold band across the brow, engraved, and the cobra rising from it beside the vulture's head.
  ctx.beginPath();
  ctx.moveTo(36.6, 25.4);
  ctx.quadraticCurveTo(50, 19.6, 63.4, 25.4);
  ctx.lineTo(63.2, 28);
  ctx.quadraticCurveTo(50, 22.4, 36.8, 28);
  ctx.closePath();
  ctx.fillStyle = vertical(ctx, 19.6, 28, ["#fff6cc", "#e0a63a", "#8a560e"]);
  ctx.fill();
  ctx.strokeStyle = "rgba(90,45,0,0.6)";
  ctx.lineWidth = 0.4;
  ctx.beginPath();
  ctx.moveTo(38, 26.6);
  ctx.quadraticCurveTo(50, 21.2, 62, 26.6);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(47.6, 25);
  ctx.bezierCurveTo(46.2, 20, 47, 15.4, 49.4, 13.6);
  ctx.lineTo(50.6, 13.6);
  ctx.bezierCurveTo(53, 15.4, 53.8, 20, 52.4, 25);
  ctx.closePath();
  ctx.fillStyle = linear(ctx, 47, 0, 53, 0, ["#8a560e", "#ffe7a0", "#c88a26"]);
  ctx.fill();
  for (const [y, color] of [
    [17.5, "#1a8a9a"],
    [20, "#b8321a"],
    [22.4, "#23409a"],
  ] as const) {
    ctx.beginPath();
    ctx.ellipse(50, y, 1.6, 0.8, 0, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
  ctx.beginPath();
  ctx.ellipse(50, 13.2, 1.1, 1.5, 0, 0, Math.PI * 2);
  ctx.fillStyle = "#e8b448";
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(46.8, 24.6);
  ctx.quadraticCurveTo(44.6, 21.4, 45.8, 19.2);
  ctx.quadraticCurveTo(46.6, 21, 47.6, 22.4);
  ctx.closePath();
  ctx.fillStyle = "#d89a36";
  ctx.fill();

  // The plaited beard in red and gold, curling forward at its end.
  const beard = new Path2D("M46.8 57.4 L53.2 57.4 L52.8 70 Q52.6 73.6 50 74.4 Q47.4 73.6 47.2 70 Z");
  ctx.save();
  glow(ctx, "rgba(0,0,0,0.5)", 2);
  ctx.fillStyle = linear(ctx, 46.8, 0, 53.2, 0, ["#7a1204", "#ff6a26", "#e8401a", "#6a0e02"]);
  ctx.fill(beard);
  ctx.restore();
  ctx.save();
  ctx.clip(beard);
  ctx.strokeStyle = "#ffcc5a";
  ctx.lineWidth = 0.7;
  for (let y = 58.6; y < 75; y += 2.1) {
    ctx.beginPath();
    ctx.moveTo(46.6, y);
    ctx.lineTo(50, y + 1.1);
    ctx.lineTo(53.4, y);
    ctx.stroke();
  }
  ctx.restore();

  // The flail: a banded rod across the chest from the left, its strands of beads hanging down the side.
  const rod = sample([
    [16, 56, 4],
    [30, 72, 4.2],
    [44, 86, 4.2],
    [56, 98, 4.2],
  ]);
  ctx.save();
  glow(ctx, "rgba(0,0,0,0.6)", 2);
  brush(ctx, [rod], 1, "#5a3204");
  ctx.restore();
  brush(ctx, [rod], 0.78, linear(ctx, 0, 50, 8, 58, METAL));
  rod.forEach(([x, y, width], index) => {
    if (index % 30 > 5 || index < 10) return;
    ctx.beginPath();
    ctx.arc(x, y, (width / 2) * 0.8, 0, Math.PI * 2);
    ctx.fillStyle = "#1f3a96";
    ctx.fill();
  });
  brush(ctx, [rod], 0.22, "rgba(255,250,220,0.55)");
  for (const [x, color] of [
    [11, "#3a6ad8"],
    [14, "#c8321a"],
    [17, "#3a6ad8"],
    [20, "#c8321a"],
    [23, "#3a6ad8"],
  ] as const) {
    // A long gold tassel with a few coloured beads.
    const strand = sample([
      [17, 58, 1.8],
      [(17 + x) / 2, 76, 1.8],
      [x - 1.2, 96, 1.4],
    ]);
    brush(ctx, [strand], 1.2, "#4a2804");
    brush(ctx, [strand], 0.9, vertical(ctx, 58, 96, ["#fff2b8", "#e0a63a", "#8a560e"]));
    for (const t of [0.3, 0.62, 0.9]) {
      const [bx, by] = strand[Math.floor(t * (strand.length - 1))];
      ctx.beginPath();
      ctx.ellipse(bx, by, 1.1, 1.6, 0, 0, Math.PI * 2);
      ctx.fillStyle = radial(ctx, bx, by, 1.6, ["#ffffff", color, "rgba(20,10,0,0.9)"], bx - 0.4, by - 0.6);
      ctx.fill();
    }
  }
  ctx.beginPath();
  ctx.arc(16, 56, 3.4, 0, Math.PI * 2);
  ctx.fillStyle = radial(ctx, 16, 56, 3.4, ["#fff6cc", "#e0a63a", "#6a3c08"], 14.8, 54.8);
  ctx.fill();

  // The crook: gold banded with lapis, a dark edge and a long highlight, from the chest up to its hook at the right.
  const crook = sample([
    [48, 99, 4.8],
    [58, 90, 4.8],
    [68, 79, 4.8],
    [72, 70, 4.8],
    [71, 60, 4.8],
    [76, 51, 4.8],
    [85, 49, 4.8],
    [91, 55, 4.6],
    [91, 64, 4.4],
    [85, 70, 4.2],
    [79, 70, 3.8],
  ]);
  ctx.save();
  glow(ctx, "rgba(0,0,0,0.6)", 2.5);
  brush(ctx, [crook], 1.12, "#0a1030");
  ctx.restore();
  // Gold, banded with lapis in equal lengths: each band a square-ended stroke, so it doesn't spill onto the gold.
  brush(ctx, [crook], 0.92, "#e8b030");
  brush(ctx, [crook.map(([x, y, w]) => [x - 0.5, y - 0.5, w] as Knot)], 0.45, "#ffe48a");
  ctx.lineCap = "butt";
  for (let start = 0; start < crook.length; start += 22) {
    const band = crook.slice(start, start + 11);
    if (band.length < 2) continue;
    for (const [width, color, shift] of [
      [0.92, "#1a2a8e", 0],
      [0.42, "#4a6ad8", -0.5],
    ] as const) {
      ctx.beginPath();
      band.forEach(([x, y], index) => (index ? ctx.lineTo(x + shift, y + shift) : ctx.moveTo(x + shift, y + shift)));
      ctx.lineWidth = band[0][2] * width;
      ctx.strokeStyle = color;
      ctx.stroke();
    }
  }
  brush(ctx, [crook.map(([x, y, w]) => [x - 0.8, y - 0.8, w] as Knot)], 0.14, "rgba(255,255,255,0.5)");
};

/** One of the goddess's wings, from her shoulder at (x, y) up to its tip (`side` -1 left, 1 right): rows of inlaid feathers in gold, lapis and turquoise. */
function wing(ctx: CanvasRenderingContext2D, x: number, y: number, side: number) {
  const s = (dx: number) => x + side * dx;
  const shape = new Path2D(
    `M${s(0)} ${y} C${s(-18)} ${y - 4} ${s(-33)} ${y - 20} ${s(-38)} ${y - 42} C${s(-50)} ${y - 30} ${s(-50)} ${y - 6} ${s(-38)} ${y + 3} C${s(-27)} ${y + 11} ${s(-12)} ${y + 12} ${s(0)} ${y + 8} Z`,
  );
  ctx.save();
  glow(ctx, "rgba(255,140,30,0.85)", 8);
  ctx.fillStyle = linear(ctx, s(-30), y - 40, s(0), y + 10, ["#ffd98a", "#f39a2a", "#c8601a", "#ffcf6a"]);
  ctx.fill(shape);
  ctx.restore();
  ctx.save();
  ctx.clip(shape);
  /** A point along a feather row: `t` from the body (0) to the wing's outer edge (1), `offset` below the leading edge. */
  const along = (t: number, offset: number): [number, number] => {
    const u = 1 - t;
    const dx = u ** 3 * 2 + 3 * u * u * t * -16 + 3 * u * t * t * -32 + t ** 3 * -44;
    const dy = u ** 3 * 4 + 3 * u * u * t * 4 + 3 * u * t * t * -4 + t ** 3 * -20;
    return [s(dx), y + dy + offset];
  };
  // Small covert feathers near the leading edge: scales in gold.
  for (let r = 0; r < 3; r += 1) {
    for (let i = 0; i < 14; i += 1) {
      const t = (i + (r % 2) * 0.5) / 14;
      const [fx, fy] = along(t, -10 + r * 2.6);
      ctx.beginPath();
      ctx.arc(fx, fy, 1.7, 0, Math.PI);
      ctx.fillStyle = r % 2 ? "#ffd98a" : "#e89a32";
      ctx.fill();
      ctx.strokeStyle = "rgba(110,50,0,0.55)";
      ctx.lineWidth = 0.4;
      ctx.stroke();
    }
  }
  // Rows of long inlaid feathers: lapis, then turquoise, each feather a rounded cell in a gold setting.
  for (const [offset, light, dark, length] of [
    [-4, "#5a80ff", "#14248a", 8.5],
    [4.4, "#6af0ee", "#0e7a8a", 7.5],
  ] as const) {
    for (let i = 0; i < 15; i += 1) {
      const t = (i + 0.5) / 15;
      const [fx, fy] = along(t, offset);
      const [nx, ny] = along(Math.min(1, t + 0.02), offset);
      const angle = Math.atan2(ny - fy, nx - fx) + Math.PI / 2;
      ctx.save();
      ctx.translate(fx, fy);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.roundRect(-1.5, -length / 2, 3, length, 1.4);
      ctx.fillStyle = linear(ctx, 0, -length / 2, 0, length / 2, [light, dark]);
      ctx.fill();
      ctx.strokeStyle = "#ffd27a";
      ctx.lineWidth = 0.45;
      ctx.stroke();
      ctx.restore();
    }
  }
  // Long flight feathers fanning to the outer edge, gold with a dark shaft.
  for (let i = 0; i < 12; i += 1) {
    const t = (i + 0.5) / 12;
    const [fx, fy] = along(t, 7);
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.quadraticCurveTo(fx + side * -2 * t, fy + 6, fx + side * (-4 - t * 6), fy + 10 - t * 2);
    ctx.strokeStyle = "rgba(110,40,0,0.55)";
    ctx.lineWidth = 0.6;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(fx + side * 1.2, fy);
    ctx.quadraticCurveTo(fx + side * (1.2 - 2 * t), fy + 6, fx + side * (-2.8 - t * 6), fy + 10 - t * 2);
    ctx.strokeStyle = "rgba(255,236,170,0.5)";
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }
  ctx.restore();
  // Light along the leading edge.
  ctx.beginPath();
  ctx.moveTo(s(0), y);
  ctx.bezierCurveTo(s(-18), y - 4, s(-33), y - 20, s(-38), y - 42);
  ctx.strokeStyle = "rgba(255,246,204,0.8)";
  ctx.lineWidth = 0.9;
  ctx.stroke();
}

/**
 * The winged goddess Isis, kneeling in profile on a gold plinth: wings of
 * inlaid feathers held out from her arms, a pleated sheath dress, a striped
 * wig, and the red sun between cow horns on her head.
 */
const statue: Icon = (ctx) => {
  wing(ctx, 45, 50, -1);
  wing(ctx, 55, 50, 1);

  // The plinth: lit top, engraved front, the side in shadow, on a lower step.
  ctx.save();
  glow(ctx, "rgba(255,150,40,0.6)", 5);
  ctx.beginPath();
  ctx.moveTo(24, 96);
  ctx.lineTo(80, 96);
  ctx.lineTo(82, 93);
  ctx.lineTo(26, 93);
  ctx.closePath();
  ctx.fillStyle = "#8a5410";
  ctx.fill();
  ctx.fillStyle = vertical(ctx, 89, 93, ["#d89a36", "#7a4a0c"]);
  ctx.fillRect(24, 89, 56, 4);
  ctx.restore();
  ctx.beginPath();
  ctx.moveTo(27, 79);
  ctx.lineTo(78, 79);
  ctx.lineTo(81, 76);
  ctx.lineTo(30, 76);
  ctx.closePath();
  ctx.fillStyle = linear(ctx, 30, 76, 80, 79, ["#fff6cc", "#ffe08a", "#e8b448"]);
  ctx.fill();
  ctx.fillStyle = vertical(ctx, 79, 89, METAL.slice(1));
  ctx.fillRect(27, 79, 51, 10);
  ctx.beginPath();
  ctx.moveTo(78, 79);
  ctx.lineTo(81, 76);
  ctx.lineTo(81, 86);
  ctx.lineTo(78, 89);
  ctx.closePath();
  ctx.fillStyle = vertical(ctx, 76, 89, ["#a8701e", "#4a2a06"]);
  ctx.fill();
  // An engraved border, and a line of hieroglyphs.
  ctx.strokeStyle = "rgba(90,45,0,0.75)";
  ctx.lineWidth = 0.5;
  ctx.strokeRect(29, 80.6, 47, 6.8);
  ctx.strokeStyle = "rgba(255,246,204,0.5)";
  ctx.strokeRect(29.4, 81, 47, 6.8);
  ctx.strokeStyle = "rgba(80,40,0,0.6)";
  ctx.lineWidth = 0.5;
  const marks = [
    (x: number) => {
      ctx.moveTo(x + 1.2, 82);
      ctx.lineTo(x + 1.2, 86.6);
      ctx.moveTo(x, 83.8);
      ctx.lineTo(x + 2.4, 83.8);
    },
    (x: number) => {
      ctx.moveTo(x, 85.6);
      ctx.quadraticCurveTo(x + 1.3, 81.6, x + 2.6, 85.6);
    },
    (x: number) => {
      ctx.moveTo(x, 84);
      ctx.lineTo(x + 0.8, 83);
      ctx.lineTo(x + 1.6, 84);
      ctx.lineTo(x + 2.4, 83);
    },
    (x: number) => {
      ctx.moveTo(x + 0.4, 86.6);
      ctx.lineTo(x + 0.4, 82.2);
      ctx.lineTo(x + 2.2, 82.2);
      ctx.lineTo(x + 2.2, 86.6);
    },
    (x: number) => {
      ctx.moveTo(x + 1.3, 84);
      ctx.arc(x + 1.3, 84, 1.3, 0, Math.PI * 2);
    },
  ];
  ctx.beginPath();
  for (let i = 0; i < 12; i += 1) marks[(i * 3) % marks.length](31 + i * 3.7);
  ctx.stroke();

  // Her kneeling body in a pleated sheath dress, sitting back on her heels.
  const body = new Path2D(
    "M45 46 Q50 43.5 55.5 46 L56.2 50.5 Q58.4 53 56.6 56.2 L55.4 60 Q60.4 62 65 66 Q68.6 69.2 67.2 73.6 Q66 77 61 77 L41 77 Q37.4 77 38 72 Q38.6 66 44 62 L45.4 55 Z",
  );
  ctx.save();
  glow(ctx, "rgba(0,0,0,0.5)", 2);
  ctx.fillStyle = linear(ctx, 38, 44, 68, 78, ["#fff0b8", "#eab04a", "#a8661a", "#5e3006", "#a8701e"]);
  ctx.fill(body);
  ctx.restore();
  ctx.save();
  ctx.clip(body);
  // Pleats along the thigh, shadow under the breast and in the lap, light on the knee and shoulder.
  ctx.strokeStyle = "rgba(90,45,0,0.5)";
  ctx.lineWidth = 0.4;
  for (let i = 0; i < 6; i += 1) {
    ctx.beginPath();
    ctx.moveTo(44 + i * 0.6, 63 + i * 2.2);
    ctx.quadraticCurveTo(55, 63 + i * 2, 66, 69 + i * 1.2);
    ctx.stroke();
  }
  const light = (x: number, y: number, r: number, color: string) => {
    ctx.fillStyle = radial(ctx, x, y, r, [color, "rgba(0,0,0,0)"]);
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };
  light(65, 69, 4, "rgba(255,250,220,0.6)");
  light(52, 48, 5, "rgba(255,250,220,0.45)");
  light(54, 58, 3.5, "rgba(80,30,0,0.5)");
  light(47, 76, 6, "rgba(60,25,0,0.5)");
  ctx.restore();
  // A belt with an inlaid buckle, its ties hanging.
  ctx.beginPath();
  ctx.moveTo(45.2, 58);
  ctx.quadraticCurveTo(50, 59.6, 55.8, 58.6);
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = "#1f3a96";
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(45.2, 58);
  ctx.quadraticCurveTo(50, 59.6, 55.8, 58.6);
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = "#ffd27a";
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(50.6, 59.4);
  ctx.quadraticCurveTo(50, 64, 51.4, 68);
  ctx.moveTo(51.6, 59.4);
  ctx.quadraticCurveTo(52, 63.4, 53.6, 67);
  ctx.lineWidth = 0.9;
  ctx.strokeStyle = "#b8321a";
  ctx.stroke();
  // A small broad collar at the shoulders.
  for (const [r, color] of [
    [5.6, "#1a8a9a"],
    [4.4, "#b8321a"],
    [3.2, "#ffd27a"],
  ] as const) {
    ctx.beginPath();
    ctx.ellipse(51, 46.5, r, r * 0.55, 0, 0, Math.PI);
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
  // Arms reaching out along the wings, with lapis armlets.
  for (const side of [-1, 1]) {
    const arm = sample([
      [50 + side * 4.6, 47.5, 2.6],
      [50 + side * 10, 46, 2.3],
      [50 + side * 16, 43, 2],
      [50 + side * 21, 39, 1.8],
    ]);
    brush(ctx, [arm], 1.2, "#6a3c08");
    brush(ctx, [arm], 1, linear(ctx, 0, 38, 0, 49, ["#ffe7a0", "#d89a36", "#8a560e"]));
    const [ax, ay] = arm[Math.floor(arm.length * 0.45)];
    ctx.beginPath();
    ctx.arc(ax, ay, 1.4, 0, Math.PI * 2);
    ctx.fillStyle = "#1f3a96";
    ctx.fill();
  }

  // Her head in profile: a striped wig, the gold face with a painted eye.
  const wig = new Path2D("M45.4 31 Q49.4 25.2 55.4 29 L56.2 33.6 L53.8 35.6 L54.6 46 Q50 47.6 45.8 45.6 Q44.4 39 45.4 31 Z");
  ctx.fillStyle = linear(ctx, 45, 26, 56, 47, ["#6a9aff", "#2a5ae0", "#10288a"]);
  ctx.fill(wig);
  ctx.save();
  ctx.clip(wig);
  ctx.strokeStyle = "rgba(8,24,110,0.55)";
  ctx.lineWidth = 0.35;
  for (let x = 44; x < 57; x += 1.1) {
    ctx.beginPath();
    ctx.moveTo(x + 2, 26);
    ctx.quadraticCurveTo(x - 0.6, 36, x, 47);
    ctx.stroke();
  }
  ctx.restore();
  const face = new Path2D(
    "M53.4 29.6 Q56.4 30.4 56.8 33.4 L58.6 36.4 Q58.4 37.4 57.2 37.6 L57.8 38.6 L57 39.4 L57.6 40.2 Q57.4 41.8 56.2 42.2 L53.4 42.6 L53.6 46.4 L51.4 46.4 L51.6 36 Z",
  );
  ctx.fillStyle = linear(ctx, 51, 30, 58, 46, ["#fff0b8", "#e8b04a", "#9a6014"]);
  ctx.fill(face);
  ctx.beginPath();
  ctx.moveTo(54.2, 34.6);
  ctx.quadraticCurveTo(55.4, 33.6, 56.6, 34.4);
  ctx.quadraticCurveTo(55.4, 35.4, 54.2, 34.6);
  ctx.fillStyle = "#f4ecd8";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(55.8, 34.5, 0.5, 0, Math.PI * 2);
  ctx.fillStyle = "#140a04";
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(56.8, 34.4);
  ctx.quadraticCurveTo(55.4, 33.2, 53.4, 34.4);
  ctx.lineTo(51.8, 34.6);
  ctx.moveTo(54.2, 32.6);
  ctx.quadraticCurveTo(55.6, 32, 56.8, 32.8);
  ctx.lineWidth = 0.45;
  ctx.strokeStyle = "#0e0a20";
  ctx.stroke();
  // A gold band round the wig, the cobra at her brow.
  ctx.beginPath();
  ctx.moveTo(45, 31.4);
  ctx.quadraticCurveTo(50, 28, 56.4, 30.6);
  ctx.lineWidth = 1.3;
  ctx.strokeStyle = "#ffd27a";
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(56, 30.4);
  ctx.quadraticCurveTo(57.6, 28.4, 57, 26.8);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#e8b448";
  ctx.stroke();

  // Cow horns cradling the red sun disc.
  ctx.beginPath();
  ctx.moveTo(48.6, 27);
  ctx.bezierCurveTo(42.6, 25, 42.6, 15, 46.4, 11.4);
  ctx.moveTo(52.4, 27);
  ctx.bezierCurveTo(58.4, 25, 58.4, 15, 54.6, 11.4);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = linear(ctx, 0, 11, 0, 27, ["#fff2b8", "#c88a26"]);
  ctx.stroke();
  ctx.save();
  glow(ctx, "rgba(255,30,10,0.95)", 9);
  ctx.beginPath();
  ctx.arc(50.5, 18.6, 7, 0, Math.PI * 2);
  ctx.fillStyle = radial(ctx, 50.5, 18.6, 7, ["#ffd0b0", "#ff3a1a", "#b00a02", "#5a0400"], 48.6, 16.4);
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.ellipse(48.8, 17.2, 1.6, 1, -0.5, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(50.5, 18.6, 7, 0, Math.PI * 2);
  ctx.lineWidth = 0.6;
  ctx.strokeStyle = "#ffd27a";
  ctx.stroke();
};

/** A few blotches of light and shade inside the current clip, at fixed spots: stone or enamel that isn't flat. */
function mottle(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, light: string, dark: string) {
  for (let i = 0; i < 14; i += 1) {
    const a = i * 2.39996;
    const d = Math.sqrt((i + 0.5) / 14);
    const [bx, by] = [x + Math.cos(a) * rx * d, y + Math.sin(a) * ry * d];
    const r = 2 + (i % 3);
    ctx.fillStyle = radial(ctx, bx, by, r, [i % 2 ? light : dark, "rgba(0,0,0,0)"]);
    ctx.fillRect(bx - r, by - r, r * 2, r * 2);
  }
}

/** The scarab: a mottled turquoise beetle on ochre inside a barrel-shaped gold cartouche, red and blue inlays down its sides, a blue glow round it. */
const scarab: Icon = (ctx) => {
  const outer = new Path2D("M29 6 L71 6 C80 22 85 36 85 50 C85 64 80 78 71 94 L29 94 C20 78 15 64 15 50 C15 36 20 22 29 6 Z");
  const inner = new Path2D("M32.5 11.5 L67.5 11.5 C75 25 79 38 79 50 C79 62 75 75 67.5 88.5 L32.5 88.5 C25 75 21 62 21 50 C21 38 25 25 32.5 11.5 Z");
  ctx.save();
  glow(ctx, "rgba(30,90,255,0.95)", 9);
  ctx.fillStyle = linear(ctx, 15, 0, 85, 0, ["#6a3e08", "#ffe08a", "#c98e24", "#f0c050", "#c98e24", "#ffe08a", "#6a3e08"]);
  ctx.fill(outer);
  ctx.restore();
  // The rim is beaded gold: a row of small lit beads round it.
  ctx.save();
  ctx.clip(outer);
  ctx.setLineDash([1.6, 1.4]);
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = "rgba(255,246,200,0.75)";
  ctx.stroke(new Path2D("M31 8.8 L69 8.8 C77.5 23 82 37 82 50 C82 63 77.5 77 69 91.2 L31 91.2 C22.5 77 18 63 18 50 C18 37 22.5 23 31 8.8 Z"));
  ctx.setLineDash([]);
  ctx.restore();
  ctx.strokeStyle = "rgba(60,30,0,0.8)";
  ctx.lineWidth = 0.8;
  ctx.stroke(outer);
  ctx.fillStyle = radial(ctx, 50, 50, 42, ["#9a6420", "#7a4a14", "#4a2806"]);
  ctx.fill(inner);
  ctx.strokeStyle = "rgba(40,20,0,0.9)";
  ctx.lineWidth = 1;
  ctx.stroke(inner);
  // Inlays down each side: red and blue blocks set in gold.
  ctx.save();
  ctx.clip(inner);
  for (const side of [-1, 1]) {
    const band = new Path2D(`M${50 + side * 22} 26 C${50 + side * 27} 38 ${50 + side * 27} 62 ${50 + side * 22} 76`);
    ctx.lineWidth = 5;
    ctx.strokeStyle = "#e8b448";
    ctx.stroke(band);
    ctx.lineWidth = 3.6;
    for (const [color, offset] of [
      ["#c8281a", 0],
      ["#1f3aa8", 5],
    ] as const) {
      ctx.setLineDash([3.8, 6.2]);
      ctx.lineDashOffset = -offset;
      ctx.strokeStyle = color;
      ctx.stroke(band);
    }
    ctx.setLineDash([]);
  }
  ctx.restore();
  // Six thick turquoise legs edged in gold: big brackets up to the top corners, short ones at the sides, brackets down to the bottom.
  const legs: Knot[][] = [];
  for (const side of [-1, 1]) {
    const s = (dx: number) => 50 + side * dx;
    legs.push(
      sample([
        [s(8), 30, 4.5],
        [s(11), 21, 5.5],
        [s(16), 16, 6],
        [s(21), 20, 6],
        [s(22), 31, 5.5],
        [s(19), 41, 4.5],
      ]),
    );
    legs.push(
      sample([
        [s(14), 52, 4.5],
        [s(20), 55, 5],
        [s(22), 60, 4],
      ]),
    );
    legs.push(
      sample([
        [s(13), 70, 4.5],
        [s(19), 75, 5.5],
        [s(21), 83, 5.5],
        [s(17), 88, 4.5],
      ]),
    );
  }
  brush(ctx, legs, 1.22, "#f0c050");
  brush(ctx, legs, 1.05, "#5a3a08");
  brush(ctx, legs, 0.92, linear(ctx, 0, 12, 0, 90, ["#7af0e8", "#20b0b8", "#0a6a80"]));
  brush(ctx, shifted(legs, -0.5, -0.6), 0.32, "rgba(220,255,250,0.6)");
  // The beetle: head, thorax and the big rounded body, in mottled turquoise enamel edged in gold.
  const shell = (x: number, y: number, rx: number, ry: number) => {
    const part = new Path2D();
    part.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.save();
    glow(ctx, "rgba(0,0,0,0.55)", 2.5);
    ctx.fillStyle = "#e8b448";
    ctx.fill(part);
    ctx.restore();
    const enamel = new Path2D();
    enamel.ellipse(x, y, rx - 1.1, ry - 1.1, 0, 0, Math.PI * 2);
    ctx.fillStyle = radial(ctx, x, y, Math.max(rx, ry) * 1.1, ["#a8fff0", "#2ac0c0", "#0c7a90", "#063a5a"], x - rx * 0.35, y - ry * 0.4);
    ctx.fill(enamel);
    ctx.save();
    ctx.clip(enamel);
    mottle(ctx, x, y, rx, ry, "rgba(170,255,240,0.45)", "rgba(0,40,70,0.45)");
    ctx.restore();
  };
  shell(50, 58, 17, 20);
  shell(50, 37.5, 13, 7.5);
  shell(50, 27.5, 7, 4.5);
  ctx.strokeStyle = "rgba(240,192,80,0.9)";
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.moveTo(50, 39);
  ctx.lineTo(50, 77);
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.4)";
  ctx.beginPath();
  ctx.ellipse(43, 50, 2.6, 7, -0.25, 0, Math.PI * 2);
  ctx.ellipse(45, 35.5, 3.5, 1.6, -0.2, 0, Math.PI * 2);
  ctx.fill();
};

const ICONS: Record<BookSymbol, Icon> = {
  BOOK: book,
  EXPLORER: explorer,
  PHARAOH: pharaoh,
  STATUE: statue,
  SCARAB: scarab,
  ACE,
  KING,
  QUEEN,
  JACK,
  TEN,
};

/** Pictures from the art folder, once loadBookArt has run. */
const images = new Map<string, HTMLImageElement>();
let loading: Promise<void> | null = null;

/**
 * Loads whatever pictures the art folder's manifest lists (none is fine).
 * Call before drawing the reels; drawing waits for nothing.
 */
export function loadBookArt(): Promise<void> {
  loading ??= (async () => {
    try {
      const res = await fetch(`${ART_FOLDER}/manifest.json`, { cache: "no-cache" });
      if (!res.ok) return;
      const manifest = (await res.json()) as Record<string, string>;
      await Promise.all(
        Object.entries(manifest)
          .filter(([, file]) => typeof file === "string" && file.trim())
          .map(
            ([name, file]) =>
              new Promise<void>((resolve) => {
                const image = new Image();
                image.onload = () => {
                  images.set(name, image);
                  resolve();
                };
                image.onerror = () => resolve();
                image.src = `${ART_FOLDER}/${file}`;
              }),
          ),
      );
    } catch {
      // No manifest, or it can't be read: every picture is drawn.
    }
  })();
  return loading;
}

/** A picture from the art folder, if the manifest lists one for `name` (a symbol, or "cover"). */
export const bookArt = (name: string): HTMLImageElement | null => images.get(name) ?? null;

const drawn = new Map<string, HTMLCanvasElement>();

/** `art` filled in one colour: its silhouette. */
function silhouette(art: HTMLCanvasElement, color: string): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = art.width;
  out.height = art.height;
  // On the CPU, like the symbol it goes into (see drawBookSymbol): copying between GPU and CPU canvases waits on the GPU.
  const ctx = out.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(art, 0, 0);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, out.width, out.height);
  return out;
}

/** Draws a silhouette all round, `radius` out: a rim of that colour around the picture. */
function rim(ctx: CanvasRenderingContext2D, shape: HTMLCanvasElement, radius: number) {
  for (const reach of [radius, radius * 0.5]) {
    for (let i = 0; i < 24; i += 1) {
      const angle = (i * Math.PI * 2) / 24;
      ctx.drawImage(shape, Math.cos(angle) * reach, Math.sin(angle) * reach);
    }
  }
}

/** A square picture of a symbol, `size` pixels across, on the dark reel: the art folder's picture, or the drawn one with a gold rim. */
export function drawBookSymbol(symbol: string, size: number): HTMLCanvasElement {
  const key = `${symbol}:${size}`;
  const cached = drawn.get(key);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  // Drawn on the CPU: the picture is read back (as a data URL, or into the reels' textures), and reading a
  // GPU canvas waits for the GPU, which the reels keep busy. On the Book page that held the page up to a second.
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  // Transparent: the reel behind it (stone with hieroglyphs) shows through.

  const image = images.get(symbol);
  const icon = ICONS[symbol as BookSymbol];
  if (image) {
    // Fitted to the cell, keeping its shape: the original's pictures fill their cells.
    const scale = Math.min(size / image.width, size / image.height);
    const w = image.width * scale;
    const h = image.height * scale;
    ctx.drawImage(image, (size - w) / 2, (size - h) / 2, w, h);
  } else if (icon) {
    const art = document.createElement("canvas");
    art.width = size;
    art.height = size;
    const artCtx = art.getContext("2d", { willReadFrequently: true })!;
    const box = size * 0.94;
    artCtx.translate((size - box) / 2, (size - box) / 2);
    artCtx.scale(box / 100, box / 100);
    icon(artCtx);
    // Shade: darker at the top, fading out two-thirds of the way down, as the original's light falls.
    artCtx.setTransform(1, 0, 0, 1, 0, 0);
    artCtx.globalCompositeOperation = "source-atop";
    artCtx.fillStyle = vertical(artCtx, 0, size, ["rgba(0,0,0,0.34)", "rgba(0,0,0,0.12)", "rgba(0,0,0,0)"]);
    artCtx.fillRect(0, 0, size, size);
    // A soft dark shadow, so the picture stands off the stone.
    rim(ctx, silhouette(art, "rgba(0,0,0,0.35)"), size * 0.01);
    ctx.drawImage(art, 0, 0);
  }
  drawn.set(key, canvas);
  return canvas;
}

const addresses = new Map<string, string>();

/** The same picture as an image address, for the rules and the list of wins. Made once per size. */
export function bookSymbolImage(symbol: string, size = 96): string {
  const key = `${symbol}:${size}`;
  let address = addresses.get(key);
  if (!address) {
    address = drawBookSymbol(symbol, size).toDataURL("image/png");
    addresses.set(key, address);
  }
  return address;
}

/**
 * Makes the small pictures (for the lists of wins, spins and the rules) ahead
 * of time, one symbol per idle moment, so none is drawn just as a spin lands.
 * Call once the art folder has loaded.
 */
export function prepareBookImages(size = 96) {
  const queue = Object.keys(ICONS);
  const idle = (work: () => void) =>
    typeof window.requestIdleCallback === "function" ? window.requestIdleCallback(work, { timeout: 2000 }) : window.setTimeout(work, 50);
  const next = () => {
    const symbol = queue.shift();
    if (!symbol) return;
    bookSymbolImage(symbol, size);
    idle(next);
  };
  idle(next);
}
