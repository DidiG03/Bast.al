"use client";

import { useEffect, useRef, useState } from "react";
import type * as THREE from "three";
import { DiceTray, type DiceThrow } from "./dice-tray";

/**
 * Dice's tray in real 3D (three.js, loaded only on this page): four ten-sided
 * dice (d10s, the real dice numbered 0 to 9), glossy white with black
 * numbers, lit with soft reflections and casting shadows on the felt. One die
 * for each digit of the roll, read from the top like real dice: 42.73 lands
 * with 4, 2, 7 and 3 up. As on a real d10, opposite faces add up to 9, and 6
 * and 9 are underlined so they can't be mixed up.
 *
 * A throw tosses each die in from the Player's side: it tumbles, hits the felt,
 * bounces twice and settles, one after another from left to right, on the
 * timings of the throw (so the knocks the game plays line up with the
 * bounces). Where WebGL isn't available, the dice are drawn in CSS instead.
 */

/** A die's radius, centre to the corners around its middle. */
const SCALE = 1.08;
/** Where each die rests on the felt, left to right, with room for the decimal point between the second and third. */
const SLOTS = [-4.05, -1.55, 1.55, 4.05];
/** When a throw's die first hits the felt, and its bounces, as fractions of its time. */
export const FIRST_IMPACT = 0.45;

/** The texture holds the ten faces in a 5 by 2 grid of square cells. */
const COLS = 5;
const CELL = 256;

/** The numbers, drawn in a grid of cells: black on white, 6 and 9 underlined. */
function faceAtlas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = CELL * COLS;
  canvas.height = CELL * 2;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fbfbfc";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let digit = 0; digit < 10; digit++) {
    const x = (digit % COLS) * CELL + CELL / 2;
    const y = Math.floor(digit / COLS) * CELL + CELL / 2;
    numeral(ctx, digit, x, y, "#0b0c0e");
  }
  return canvas;
}

/**
 * Where a face shines: the white plastic is glossy, the numbers are matte paint, so the light on
 * the top face never greys them. Red is how much clear coat, green how rough the surface is.
 */
function finishAtlas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = CELL * COLS;
  canvas.height = CELL * 2;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgb(255, 97, 0)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let digit = 0; digit < 10; digit++) numeral(ctx, digit, (digit % COLS) * CELL + CELL / 2, Math.floor(digit / COLS) * CELL + CELL / 2, "rgb(0, 255, 0)");
  return canvas;
}

/** How tall a number is, as a share of its cell. */
const NUMERAL = 0.2;

function numeral(ctx: CanvasRenderingContext2D, digit: number, x: number, y: number, color: string) {
  const height = CELL * NUMERAL;
  ctx.fillStyle = color;
  ctx.font = `700 ${Math.round(height * 1.38)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(digit), x, y + height * 0.04);
  if (digit === 6 || digit === 9) ctx.fillRect(x - height * 0.3, y + height * 0.62, height * 0.6, height * 0.09);
}

type Face = { normal: THREE.Vector3; up: THREE.Vector3; digit: number };

/**
 * A d10 (a pentagonal trapezohedron): a point at the top and bottom, ten corners zigzagging round
 * the middle, and ten kite-shaped faces, each with its number reading towards its point. Returns
 * the geometry, with each face mapped onto its number's cell, and the faces themselves.
 */
function d10(three: typeof THREE) {
  const apex = 1.02;
  const cos36 = Math.cos(Math.PI / 5);
  // How high the middle corners sit, so each kite's four corners lie flat in one plane.
  const ring = (apex * (1 - cos36)) / (1 + cos36);
  const corner = (index: number, upper: boolean) => {
    const angle = (index * Math.PI) / 5;
    return new three.Vector3(Math.cos(angle), upper ? ring : -ring, Math.sin(angle));
  };
  const top = new three.Vector3(0, apex, 0);
  const bottom = new three.Vector3(0, -apex, 0);
  // Each kite: its point, a side corner, the far tip, the other side corner.
  const kites: THREE.Vector3[][] = [];
  for (let k = 0; k < 5; k++) kites.push([top, corner(2 * k, true), corner(2 * k + 1, false), corner(2 * k + 2, true)]);
  for (let k = 0; k < 5; k++) kites.push([bottom, corner(2 * k + 1, false), corner(2 * k + 2, true), corner(2 * k + 3, false)]);

  const normals = kites.map(([a, b, c]) => new three.Vector3().subVectors(b, a).cross(new three.Vector3().subVectors(c, a)).normalize());
  normals.forEach((normal, index) => {
    if (normal.dot(kites[index][0].clone().add(kites[index][2])) < 0) normal.negate();
  });
  // Evens round the top, and each bottom face 9 minus the face opposite it, as on a real d10.
  const digits = [0, 8, 6, 4, 2, ...normals.slice(5).map((normal) => 9 - [0, 8, 6, 4, 2][normals.slice(0, 5).findIndex((other) => other.dot(normal) < -0.99)])];

  const positions: number[] = [];
  const uvs: number[] = [];
  const faces: Face[] = kites.map((kite, index) => {
    const [point, sideA, tip, sideB] = kite;
    const normal = normals[index];
    const up = new three.Vector3().subVectors(point, tip).normalize();
    const right = new three.Vector3().crossVectors(up, normal);
    // The number sits in the kite's wide part, a little towards its point.
    const centre = tip.clone().lerp(point, 0.36);
    const local = (vertex: THREE.Vector3) => {
      const offset = new three.Vector3().subVectors(vertex, centre);
      return [offset.dot(right), offset.dot(up)] as const;
    };
    const half = Math.max(...kite.map((vertex) => Math.max(...local(vertex).map(Math.abs)))) * 1.02;
    const col = digits[index] % COLS;
    const row = Math.floor(digits[index] / COLS);
    const uv = (vertex: THREE.Vector3) => {
      const [s, t] = local(vertex);
      return [(col + 0.5 + s / (2 * half)) / COLS, 1 - (row + 0.5 - t / (2 * half)) / 2];
    };
    // Two triangles, wound so they face outwards.
    const order = new three.Vector3().subVectors(sideA, point).cross(new three.Vector3().subVectors(tip, point)).dot(normal) > 0 ? [point, sideA, tip, point, tip, sideB] : [point, tip, sideA, point, sideB, tip];
    for (const vertex of order) {
      positions.push(vertex.x, vertex.y, vertex.z);
      uvs.push(...uv(vertex));
    }
    return { normal, up, digit: digits[index] };
  });

  const geometry = new three.BufferGeometry();
  geometry.setAttribute("position", new three.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new three.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  geometry.scale(SCALE, SCALE, SCALE);
  // How high the die's centre sits when it lies on a face, and how far its points reach.
  const rest = normals[0].dot(top) * SCALE;
  return { geometry, faces, rest, reach: apex * SCALE };
}

/** The turn that lays a die with this digit facing up, its number reading towards the back of the table, then turned a little by `jitter`. */
function restingTurn(three: typeof THREE, faces: Face[], digit: number, jitter: number): THREE.Quaternion {
  const face = faces.find((candidate) => candidate.digit === digit)!;
  const lay = new three.Quaternion().setFromUnitVectors(face.normal, new three.Vector3(0, 1, 0));
  const up = face.up.clone().applyQuaternion(lay);
  const yaw = new three.Quaternion().setFromAxisAngle(new three.Vector3(0, 1, 0), Math.PI - Math.atan2(up.x, up.z) + jitter);
  return yaw.multiply(lay);
}

const easeOutCubic = (u: number) => 1 - (1 - u) ** 3;
const easeOutQuart = (u: number) => 1 - (1 - u) ** 4;

/** A die's height above the felt during its throw, at `t` from 0 to 1: falling, then two bounces. */
function hop(t: number): number {
  const drop = 5.5;
  if (t < FIRST_IMPACT) return drop * (1 - (t / FIRST_IMPACT) ** 2);
  const bounce = (from: number, to: number, height: number) => {
    const u = (t - from) / (to - from);
    return height * 4 * u * (1 - u);
  };
  if (t < 0.72) return bounce(FIRST_IMPACT, 0.72, 0.85);
  if (t < 0.86) return bounce(0.72, 0.86, 0.22);
  return 0;
}

type Scene = {
  three: typeof THREE;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  dice: THREE.Mesh[];
  faces: Face[];
  rest: number;
  reach: number;
  dispose: () => void;
};

export function Dice3D({ dice, rolling, outcome, label }: { dice: DiceThrow | null; rolling: boolean; outcome: "win" | "loss" | null; label: string }) {
  const holder = useRef<HTMLDivElement>(null);
  const world = useRef<Scene | null>(null);
  const frame = useRef<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);

  // Builds the scene once: the camera above one corner, the lights, the shadow on the felt, four dice and a decimal point.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const three = await import("three");
        const { RoomEnvironment } = await import("three/addons/environments/RoomEnvironment.js");
        if (cancelled || !holder.current) return;
        const renderer = new three.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.outputColorSpace = three.SRGBColorSpace;
        // Neutral tone mapping keeps the white plastic white and the numbers black.
        renderer.toneMapping = three.NeutralToneMapping;
        renderer.toneMappingExposure = 1;
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = three.PCFSoftShadowMap;
        renderer.domElement.className = "dice-canvas";
        holder.current.appendChild(renderer.domElement);

        const scene = new three.Scene();
        const pmrem = new three.PMREMGenerator(renderer);
        const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
        scene.environment = environment;
        // Only a soft reflection of the room, so the sun shades each face differently and the edges show.
        scene.environmentIntensity = 0.35;

        const camera = new three.OrthographicCamera(-5.6, 5.6, 2, -2, 0.1, 100);
        const elevation = (64 * Math.PI) / 180;
        camera.position.set(0, Math.sin(elevation) * 20, Math.cos(elevation) * 20);
        camera.lookAt(0, 0.75, 0);

        scene.add(new three.HemisphereLight(0xffffff, 0x2a4a3a, 0.45));
        const sun = new three.DirectionalLight(0xffffff, 2);
        sun.position.set(-7, 9, 3);
        sun.castShadow = true;
        sun.shadow.mapSize.set(1024, 1024);
        sun.shadow.camera.left = -8;
        sun.shadow.camera.right = 8;
        sun.shadow.camera.top = 6;
        sun.shadow.camera.bottom = -6;
        sun.shadow.radius = 6;
        sun.shadow.bias = -0.0005;
        scene.add(sun);

        const felt = new three.Mesh(new three.PlaneGeometry(40, 40), new three.ShadowMaterial({ opacity: 0.38 }));
        felt.rotation.x = -Math.PI / 2;
        felt.receiveShadow = true;
        scene.add(felt);

        const texture = new three.CanvasTexture(faceAtlas());
        texture.colorSpace = three.SRGBColorSpace;
        texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
        const finish = new three.CanvasTexture(finishAtlas());
        // The finish map's channels scale these: roughness 0.38 on the plastic and 1 on the numbers; clear coat only on the plastic.
        const material = new three.MeshPhysicalMaterial({ map: texture, roughness: 1, roughnessMap: finish, clearcoat: 0.5, clearcoatMap: finish, clearcoatRoughness: 0.2 });
        const { geometry, faces, rest, reach } = d10(three);
        const meshes = SLOTS.map((x) => {
          const mesh = new three.Mesh(geometry, material);
          mesh.position.set(x, rest, 0);
          mesh.quaternion.copy(restingTurn(three, faces, 0, 0));
          mesh.castShadow = true;
          scene.add(mesh);
          return mesh;
        });
        const point = new three.Mesh(new three.SphereGeometry(0.15, 24, 16), new three.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.3, clearcoat: 0.6 }));
        point.position.set(0, 0.15, 0.55);
        point.castShadow = true;
        scene.add(point);

        world.current = {
          three,
          renderer,
          scene,
          camera,
          dice: meshes,
          faces,
          rest,
          reach,
          dispose: () => {
            geometry.dispose();
            texture.dispose();
            finish.dispose();
            material.dispose();
            environment.dispose();
            pmrem.dispose();
            renderer.dispose();
            renderer.domElement.remove();
          },
        };
        setReady(true);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
      world.current?.dispose();
      world.current = null;
    };
  }, []);

  // The canvas follows the tray's size; the camera keeps the four dice framed whatever its shape.
  useEffect(() => {
    const element = holder.current;
    const current = world.current;
    if (!element || !current) return;
    const resize = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (!width || !height) return;
      current.renderer.setSize(width, height, false);
      const halfWidth = 5.7;
      const halfHeight = (halfWidth * height) / width;
      current.camera.left = -halfWidth;
      current.camera.right = halfWidth;
      current.camera.top = halfHeight;
      current.camera.bottom = -halfHeight;
      current.camera.updateProjectionMatrix();
      current.renderer.render(current.scene, current.camera);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ready]);

  // A throw: tumble each die in and settle it with its digit up, or put it straight down when there's no time to show it.
  useEffect(() => {
    const current = world.current;
    if (!current || !ready) return;
    if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    const digits = dice?.digits ?? [0, 0, 0, 0];
    const key = dice?.key ?? 0;
    const { three, rest, reach } = current;
    const rests = digits.map((digit, index) => restingTurn(three, current.faces, digit, (((key * 13 + index * 7) % 9) - 4) * 0.04));
    const settle = () => {
      current.dice.forEach((mesh, index) => {
        mesh.position.set(SLOTS[index], rest, 0);
        mesh.quaternion.copy(rests[index]);
      });
      current.renderer.render(current.scene, current.camera);
    };
    if (!dice || dice.duration <= 0) {
      settle();
      return;
    }
    const start = performance.now();
    const spins = dice.spins.map(([x, y, z]) => [(x * Math.PI) / 180, (y * Math.PI) / 180, (z * Math.PI) / 180]);
    const spin = new three.Quaternion();
    const euler = new three.Euler();
    const step = (now: number) => {
      let moving = false;
      current.dice.forEach((mesh, index) => {
        const length = dice.duration + dice.stagger * index;
        const t = Math.min(1, (now - start) / length);
        if (t < 1) moving = true;
        // Tossed from the Player's side and a little to the left, sliding to its place as it falls and bounces.
        const slide = easeOutCubic(Math.min(1, t / 0.75));
        const turn = 1 - easeOutQuart(Math.min(1, t / 0.8));
        // While it's still turning it's lifted so its points never dip into the felt.
        mesh.position.set(SLOTS[index] - 1.6 * (1 - slide), rest + hop(t) + (reach - rest) * Math.min(1, turn * 3), 2.6 * (1 - slide));
        const [x, y, z] = spins[index];
        spin.setFromEuler(euler.set(x * turn, y * turn, z * turn));
        mesh.quaternion.copy(spin).multiply(rests[index]);
      });
      current.renderer.render(current.scene, current.camera);
      if (moving) frame.current = window.requestAnimationFrame(step);
      else {
        frame.current = null;
        settle();
      }
    };
    frame.current = window.requestAnimationFrame(step);
  }, [dice, ready]);

  if (failed) return <DiceTray dice={dice} rolling={rolling} outcome={outcome} label={label} />;
  return <div ref={holder} className={`dice-tray is-3d${rolling ? " is-rolling" : ""}${outcome ? ` is-${outcome}` : ""}`} role="img" aria-label={label} />;
}
