// Finds app text with no Albanian translation, and translations nothing uses.
//   node scripts/i18n-check.mjs
// Keys come from t("…") and tn(n, "…", "…") calls; server text (ts) is
// checked separately by feeding real API messages through translateServer.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dictDir = join(root, "lib/i18n/sq");
const dict = {};
const origin = {};
for (const file of readdirSync(dictDir).filter((f) => f.endsWith(".ts") && f !== "index.ts")) {
  const mod = await import(join(dictDir, file));
  for (const [name, part] of Object.entries(mod)) {
    for (const [key, value] of Object.entries(part)) {
      if (key in dict && dict[key] !== value) console.log(`CONFLICT  "${key}"\n  ${origin[key]}: ${dict[key]}\n  ${file}/${name}: ${value}`);
      dict[key] = value;
      origin[key] = `${file}/${name}`;
    }
  }
}

function* sources(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (["node_modules", ".next", "scripts", "i18n"].includes(entry)) continue;
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(tsx?|mjs)$/.test(entry)) yield path;
  }
}

const str = String.raw`"((?:\\.|[^"\\])*)"`;
const tCall = new RegExp(String.raw`\bt\(\s*${str}`, "g");
const ternary = new RegExp(String.raw`\bt\([^()"]*?\?\s*${str}\s*:\s*${str}`, "g");
const msgCall = new RegExp(String.raw`\bmsg\(\s*${str}`, "g");
const spinnerLabel = new RegExp(String.raw`<LoadingSpinner[^>]*?label=${str}`, "g");
const tnCall = new RegExp(String.raw`\btn\(\s*[^,]+?,\s*${str}\s*,\s*${str}`, "g");
const unescape = (s) => JSON.parse(`"${s}"`);

const used = new Map();
for (const file of [...sources(join(root, "app")), ...sources(join(root, "components")), ...sources(join(root, "lib"))]) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(tCall)) used.set(unescape(m[1]), file);
  for (const m of text.matchAll(msgCall)) used.set(unescape(m[1]), file);
  for (const m of text.matchAll(ternary)) {
    used.set(unescape(m[1]), file);
    used.set(unescape(m[2]), file);
  }
  for (const m of text.matchAll(spinnerLabel)) used.set(unescape(m[1]), file);
  for (const m of text.matchAll(tnCall)) {
    used.set(unescape(m[1]), file);
    used.set(unescape(m[2]), file);
  }
}

const missing = [...used].filter(([key]) => !(key in dict));
for (const [key, file] of missing) console.log(`MISSING   ${file.replace(root, "")}: "${key}"`);
console.log(`\n${used.size} texts in the app, ${Object.keys(dict).length} in the dictionary, ${missing.length} missing.`);
process.exit(missing.length ? 1 : 0);
