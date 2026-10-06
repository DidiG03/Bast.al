"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { Application, Container, Graphics } from "pixi.js";
import type { ReelSet, WinPresenter } from "pixi-reels";
import type { SlotSymbol } from "../lib/api";
import { slotSound } from "./slot-sounds";
import { drawSymbol } from "./slot-symbols";

/**
 * A slot's reels, drawn by pixi-reels (github.com/schmooky/pixi-reels) on
 * PixiJS, for any game: it brings its symbols and how to draw them. They
 * only animate: the server decides every spin, and the page hands the result
 * to `land`. PixiJS loads with this component, so no other page carries it.
 */
export type SlotReelsHandle = {
  /** Starts the reels spinning. Resolves once they've landed on what `land` gives them; null if the reels aren't drawn yet. */
  start(): Promise<void> | null;
  /** Where to stop: grid[reel][row]. With two scatters (stars) already showing, the reels after them slow down to build suspense. */
  land(grid: string[][]): void;
  /** Book of Ra's free spins: `symbol` grows to fill each of these reels. Resolves once it has; `clear` or the next spin takes it away. */
  expand(reels: number[], symbol: string): Promise<void>;
  /**
   * Shows the wins one after another, again and again until `clear`: each
   * win's cells pulse, and a line is drawn in its colour from the left edge
   * to the right one, so it joins the line's numbers at the sides. Nothing
   * else is dimmed. `onShow` gets the index of the win now showing, and
   * `onRound` is called once, when every win has been shown once (straight
   * away if the reels aren't drawn).
   */
  present(wins: ReelWin[], onShow?: (index: number) => void, onRound?: () => void): void;
  clear(): void;
};

/**
 * One win to show. `cells`, `path` and `marks` are [reel, row]. `path` is the
 * whole line, drawn across all reels; `marks` get an outline (wins with no
 * line, like stars anywhere).
 */
export type ReelWin = {
  cells: Array<[number, number]>;
  color: string;
  path?: Array<[number, number]>;
  /** Where the line meets each edge: up or down from the row's middle, in cells, so it lands on its number. */
  ends?: [number, number];
  paths?: Array<{ path: Array<[number, number]>; color: string; ends?: [number, number] }>;
  marks?: Array<[number, number]>;
};

type Props = {
  grid: string[][];
  symbols: readonly string[];
  /** The symbol that teases: two of it on the reels and the rest slow down. */
  scatter: string;
  /** How often each symbol shows while the reels spin (looks only). */
  weights: Partial<Record<string, number>>;
  /** Draws a symbol's picture, `size` pixels square. The fruit slot's by default. */
  draw?: (symbol: string, size: number) => HTMLCanvasElement;
  /** Land straight away instead of spinning (reduced motion). */
  instant: boolean;
  onReady(): void;
  /** The reels can't be drawn here (no WebGL, say); the page shows a plain grid instead. */
  onFailed(): void;
};

const CELL = 128;
/** The bar between reels. Rows on a reel touch, so each reel reads as one strip. */
const GAP = 10;
/** Symbol pictures are drawn at this many pixels per cell pixel. */
const SHARPNESS = 2;

const drawFruit = (symbol: string, size: number) => drawSymbol(symbol as SlotSymbol, size);

export const SlotReels = forwardRef<SlotReelsHandle, Props>(function SlotReels({ grid, symbols, scatter, weights, draw: drawPicture = drawFruit, instant, onReady, onFailed }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<{
    app: Application;
    reelSet: ReelSet;
    presenter: WinPresenter;
    overlay: Graphics;
    /** Symbols filling whole reels (Book of Ra), above the reels and under the lines. */
    expanded: Container;
    expand(reels: number[], symbol: string): Promise<void>;
    anticipate(grid: string[][]): number[];
  } | null>(null);
  /** The wins being shown, and who to tell which one is up. */
  const showing = useRef<{ wins: ReelWin[]; onShow?: (index: number) => void; onRound?: () => void; shown: number }>({ wins: [], shown: 0 });
  const instantRef = useRef(instant);
  instantRef.current = instant;

  useEffect(() => {
    let disposed = false;
    let teardown = () => undefined as void;
    (async () => {
      const [{ Application, CanvasSource, Container, Graphics, Sprite, Texture }, { ReelSetBuilder, SpriteSymbol, SpeedPresets, WinPresenter, anticipationForScatters }] = await Promise.all([
        import("pixi.js"),
        import("pixi-reels"),
      ]);
      if (disposed || !host.current) return;
      const reels = grid.length;
      const rows = grid[0]?.length ?? 3;
      const app = new Application();
      await app.init({
        width: reels * CELL + (reels - 1) * GAP,
        height: rows * CELL,
        backgroundAlpha: 0,
        antialias: true,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        autoDensity: true,
      });
      if (disposed) {
        app.destroy(true);
        return;
      }
      // Drawn at twice the cell size for sharp screens, and declared at the cell's own size, so a
      // symbol always fits its cell, even one the reels haven't resized.
      const textures = Object.fromEntries(
        symbols.map((symbol) => [symbol, new Texture({ source: new CanvasSource({ resource: drawPicture(symbol, CELL * SHARPNESS), resolution: SHARPNESS }) })]),
      );
      const reelSet = new ReelSetBuilder()
        .reels(reels)
        .visibleCells(rows)
        .symbolSize(CELL, CELL)
        .symbolGap(GAP, 0)
        .symbols((registry) => {
          for (const symbol of symbols) registry.register(symbol, SpriteSymbol, { textures: { [symbol]: textures[symbol] } });
        })
        .weights(Object.fromEntries(symbols.map((symbol) => [symbol, weights[symbol] ?? 1])))
        .speed("normal", SpeedPresets.NORMAL)
        .initialFrame(grid.map((column) => ({ visible: column })))
        .ticker(app.ticker)
        .build();
      app.stage.addChild(reelSet);

      // A symbol filling a reel: its picture, big and stretched tall, on a glowing gold-framed panel the height of the reel.
      const expanded = new Container();
      app.stage.addChild(expanded);
      const tall = new Map<string, InstanceType<typeof Texture>>();
      const tallTexture = (symbol: string) => {
        let texture = tall.get(symbol);
        if (!texture) {
          const scale = SHARPNESS;
          const canvas = document.createElement("canvas");
          canvas.width = CELL * scale;
          canvas.height = rows * CELL * scale;
          const ctx = canvas.getContext("2d")!;
          const frame = ctx.createLinearGradient(0, 0, canvas.width, 0);
          frame.addColorStop(0, "#8a5a10");
          frame.addColorStop(0.5, "#fff3b0");
          frame.addColorStop(1, "#8a5a10");
          ctx.fillStyle = frame;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          const inset = 5 * scale;
          const glow = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, 0, canvas.width / 2, canvas.height / 2, canvas.height * 0.55);
          glow.addColorStop(0, "#ffe9a0");
          glow.addColorStop(0.35, "#e8901e");
          glow.addColorStop(0.75, "#6a2a06");
          glow.addColorStop(1, "#1c0a02");
          ctx.fillStyle = glow;
          ctx.fillRect(inset, inset, canvas.width - inset * 2, canvas.height - inset * 2);
          const art = drawPicture(symbol, CELL * scale * 1.6);
          const width = canvas.width * 1.18;
          const height = canvas.height * 0.66;
          ctx.drawImage(art, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
          texture = new Texture({ source: new CanvasSource({ resource: canvas, resolution: scale }) });
          tall.set(symbol, texture);
        }
        return texture;
      };
      const expand = (reelsToFill: number[], symbol: string) =>
        new Promise<void>((resolve) => {
          const sprites = reelsToFill.map((reel) => {
            const top = reelSet.getCellBounds(reel, 0);
            const sprite = new Sprite(tallTexture(symbol));
            sprite.anchor.set(0.5);
            sprite.position.set(top.x + top.width / 2, (rows * CELL) / 2);
            sprite.width = top.width;
            sprite.height = rows * CELL;
            sprite.alpha = 0;
            expanded.addChild(sprite);
            return { sprite, full: sprite.scale.y };
          });
          if (instantRef.current) {
            for (const { sprite } of sprites) sprite.alpha = 1;
            resolve();
            return;
          }
          // Each reel in turn, growing up and down from its middle.
          const started = performance.now();
          const tick = () => {
            const now = performance.now();
            let done = true;
            sprites.forEach(({ sprite, full }, index) => {
              const progress = Math.min(1, Math.max(0, (now - started - index * 350) / 450));
              if (progress < 1) done = false;
              sprite.alpha = Math.min(1, progress * 2);
              sprite.scale.y = full * (0.34 + 0.66 * (1 - (1 - progress) ** 3));
            });
            if (done) {
              app.ticker.remove(tick);
              resolve();
            }
          };
          app.ticker.add(tick);
        });

      // Lines and outlines go on top of the symbols. The reels sit at the stage's origin, so their cell bounds work here as they are.
      const overlay = new Graphics();
      app.stage.addChild(overlay);
      const centre = ([reel, row]: [number, number]) => {
        const box = reelSet.getCellBounds(reel, row);
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      };
      const draw = (win: ReelWin) => {
        overlay.clear();
        for (const { path, color, ends } of win.paths ?? (win.path ? [{ path: win.path, color: win.color, ends: win.ends }] : [])) {
          const middle = path.map(centre);
          // Out to both edges, at the height of the line's numbers.
          const [left, right] = ends ?? [0, 0];
          const points = [{ x: 0, y: middle[0].y + left * CELL }, ...middle, { x: app.screen.width, y: middle[middle.length - 1].y + right * CELL }];
          // A soft stroke under a thin bright one reads as a glow.
          for (const [width, alpha] of [[7, 0.3], [3, 1]] as const) {
            overlay.moveTo(points[0].x, points[0].y);
            for (const point of points.slice(1)) overlay.lineTo(point.x, point.y);
            overlay.stroke({ color, width, alpha, cap: "round", join: "round" });
          }
        }
        for (const [reel, row] of win.marks ?? []) {
          const box = reelSet.getCellBounds(reel, row);
          overlay.roundRect(box.x + 4, box.y + 4, box.width - 8, box.height - 8, 16).stroke({ color: win.color, width: 3 });
        }
      };
      const presenter = new WinPresenter(reelSet, {
        dimLosers: false,
        cycles: -1,
        sortByValue: false,
        // A sweep from the left reel, so the eye follows the line.
        stagger: instantRef.current ? 0 : 70,
        cycleGap: instantRef.current ? 1400 : 650,
        // Two pulses per cell. A pulse that's cut short never settles, so each one also times out, or the cycle would stall.
        symbolAnim: instantRef.current
          ? async () => undefined
          : async (symbol) => {
              for (let pulse = 0; pulse < 2; pulse += 1) await Promise.race([symbol.playWin(), new Promise((resolve) => setTimeout(resolve, 400))]);
            },
      });
      reelSet.events.on("win:group", (win) => {
        const index = win.id ?? 0;
        const shown = showing.current.wins[index];
        if (shown) draw(shown);
        showing.current.onShow?.(index);
        // The first win again: the last one has been shown in full, so the round is done.
        showing.current.shown += 1;
        if (showing.current.shown === showing.current.wins.length + 1) {
          const done = showing.current.onRound;
          showing.current.onRound = undefined;
          done?.();
        }
      });
      reelSet.events.on("win:end", () => overlay.clear());
      // A thunk as each reel lands, a chime for a star, and the ticking stops when they're all down.
      reelSet.events.on("spin:reelLanded", (reel, landed) => {
        slotSound.reelStop(reel);
        if (landed.includes(scatter)) slotSound.star(reel);
      });
      reelSet.events.on("spin:allLanded", () => slotSound.stopTicking());
      // Drawn at a fixed size and scaled to the page's width. PixiJS sets a fixed pixel size on the canvas; this replaces it.
      app.canvas.classList.add("slot-canvas");
      app.canvas.style.width = "100%";
      app.canvas.style.height = "auto";
      host.current.appendChild(app.canvas);
      engine.current = {
        app,
        reelSet,
        presenter,
        overlay,
        expanded,
        expand,
        anticipate: (next) => anticipationForScatters(next.map((column) => ({ visible: column })), { symbol: scatter, trigger: 2 }),
      };
      teardown = () => {
        presenter.destroy();
        reelSet.destroy();
        app.destroy(true, { children: true, texture: true });
      };
      onReady();
    })().catch(() => {
      if (!disposed) onFailed();
    });
    return () => {
      disposed = true;
      engine.current = null;
      // Leaving mid-spin: the reels' ticking stops with them.
      slotSound.stopTicking();
      teardown();
    };
    // Built once; later results arrive through land().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      start() {
        const current = engine.current;
        if (!current) return null;
        current.presenter.abort();
        current.overlay.clear();
        current.expanded.removeChildren();
        slotSound.spinStart();
        if (!instantRef.current) slotSound.startTicking();
        return current.reelSet.spin().then(() => undefined);
      },
      land(next) {
        const current = engine.current;
        if (!current) return;
        current.reelSet.setResult(next.map((column) => ({ visible: column })));
        if (instantRef.current) {
          current.reelSet.skipSpin();
          return;
        }
        const tease = current.anticipate(next);
        if (tease.length > 0) current.reelSet.setAnticipation(tease, { stagger: 400, duration: 1100, slowdown: { from: 0.45, to: 0.25 } });
      },
      expand(reelsToFill, symbol) {
        return engine.current?.expand(reelsToFill, symbol) ?? Promise.resolve();
      },
      present(wins, onShow, onRound) {
        const current = engine.current;
        if (!current || wins.length === 0) {
          onRound?.();
          return;
        }
        showing.current = { wins, onShow, onRound, shown: 0 };
        // show() cycles until aborted; it settles then, and nothing waits on it.
        current.presenter.show(wins.map((win, id) => ({ id, cells: win.cells.map(([reelIndex, cellIndex]) => ({ reelIndex, cellIndex })) }))).catch(() => undefined);
      },
      clear() {
        showing.current = { wins: [], shown: 0 };
        engine.current?.presenter.abort();
        engine.current?.overlay.clear();
        engine.current?.expanded.removeChildren();
      },
    }),
    [],
  );

  return <div ref={host} className="slot-reels" aria-hidden="true" />;
});
