// Finds app text with no Albanian translation, and translations nothing uses.
//   node scripts/i18n-check.mjs
// Keys come from t("…") and tn(n, "…", "…") calls. Text the API sends (ts)
// is checked too: every message in apps/api/src must have an Albanian entry,
// either word for word or as a {placeholder} pattern that fits it.
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
const spinnerLabel = new RegExp(String.raw`<(?:LoadingSpinner|PageLoading)[^>]*?label=${str}`, "g");
const helpText = new RegExp(String.raw`(?:<HelpTip[^>]*?text=|\bhelp=|\bhelp:\s*)${str}`, "g");
const spinnerChoice = new RegExp(String.raw`<(?:LoadingSpinner|PageLoading)[^>]*?label=\{[^}]*?\?\s*${str}\s*:\s*${str}\s*\}`, "g");
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
  for (const m of text.matchAll(helpText)) used.set(unescape(m[1]), file);
  for (const m of text.matchAll(spinnerChoice)) {
    used.set(unescape(m[1]), file);
    used.set(unescape(m[2]), file);
  }
  for (const m of text.matchAll(tnCall)) {
    used.set(unescape(m[1]), file);
    used.set(unescape(m[2]), file);
  }
}

const missing = [...used].filter(([key]) => !(key in dict));
for (const [key, file] of missing) console.log(`MISSING   ${file.replace(root, "")}: "${key}"`);
console.log(`\n${used.size} texts in the app, ${Object.keys(dict).length} in the dictionary, ${missing.length} missing.`);

// ---- Text the API sends ----

const { createServerTranslator } = await import(join(root, "lib/i18n/match.ts"));
const translateSq = createServerTranslator(dict);
const apiRoot = join(root, "../api/src");

// Never shown to anyone, or only to developers: config errors, upstream feed errors, docs.
const API_SKIP_FILES = /(^|\/)(main\.ts|health\.controller\.ts|crypto\/|odds\/mock-feed\.ts)/;
const API_SKIP_LINE = /logger\.|console\.|\bimport\b|Prisma\.sql|\$queryRaw|\$executeRaw|process\.env|@ApiProperty|Bearer /;
const API_SKIP_TEXT = new Set([
  "Clerk token missing subject", // caught by the auth guard, which answers with its own message
  "Mobile device", // device label kept in the security log
  "Idempotent-Replayed: true", // response header
  "Empty raw webhook payload — ensure Nest is started with rawBody: true", // answered to Clerk's webhook
]);

/**
 * String and template literals in a TypeScript file. Templates come back as
 * their fixed chunks plus the source of each `${…}`; literals inside a
 * `${…}` are marked `nested`, since the template they sit in is what's shown.
 */
function literals(source) {
  const found = [];
  let i = 0;
  const lineAt = (at) => source.slice(0, at).split("\n").length;
  const context = (at) => source.slice(Math.max(0, at - 160), at).replace(/\s+/g, " ");
  function readString(quote, nested) {
    const start = i;
    i++;
    let text = "";
    while (i < source.length && source[i] !== quote) {
      if (source[i] === "\\") {
        text += source.slice(i, i + 2);
        i += 2;
      } else text += source[i++];
    }
    i++;
    let value;
    try {
      value = JSON.parse(`"${text.replace(/\\'/g, "'").replace(/"/g, '\\"')}"`);
    } catch {
      value = text;
    }
    found.push({ kind: "string", text: value, nested, line: lineAt(start), before: context(start) });
  }
  function readTemplate(nested) {
    const start = i;
    i++;
    const chunks = [""];
    const exprs = [];
    while (i < source.length && source[i] !== "`") {
      if (source[i] === "\\") {
        chunks[chunks.length - 1] += source[i + 1];
        i += 2;
      } else if (source[i] === "$" && source[i + 1] === "{") {
        i += 2;
        exprs.push(readCode(true));
        chunks.push("");
      } else chunks[chunks.length - 1] += source[i++];
    }
    i++;
    found.push({ kind: "template", chunks, exprs, text: chunks.join("…"), nested, line: lineAt(start), before: context(start) });
  }
  // Reads code up to the `}` closing a template's `${`, or to the end of the file.
  function readCode(nested) {
    const start = i;
    let depth = 0;
    while (i < source.length) {
      const c = source[i];
      if (c === "/" && source[i + 1] === "/") i = source.indexOf("\n", i) === -1 ? source.length : source.indexOf("\n", i);
      else if (c === "/" && source[i + 1] === "*") i = source.indexOf("*/", i) + 2;
      else if (c === '"' || c === "'") readString(c, nested);
      else if (c === "`") readTemplate(nested);
      else if (c === "{") (depth++, i++);
      else if (c === "}") {
        if (nested && depth === 0) {
          i++;
          return source.slice(start, i - 1);
        }
        depth--;
        i++;
      } else i++;
    }
    return source.slice(start, i);
  }
  readCode(false);
  return found;
}

const hole = "\u0001";
const patternKeys = Object.keys(dict).map((key) => key.replace(/\{\w+\}/g, hole));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every wording a template can produce: `cond ? "a" : "b"` gives both, anything else is a hole. */
function templateShapes(chunks, exprs) {
  let shapes = [escape(chunks[0])];
  exprs.forEach((expr, index) => {
    const pick = /^[^"`]*\?\s*"([^"]*)"\s*:\s*"([^"]*)"\s*$/.exec(expr);
    const options = pick ? [escape(pick[1]), escape(pick[2])] : [".+"];
    // "$" before a hole is the currency sign; the dictionary puts it inside {amount}.
    shapes = shapes.flatMap((shape) => options.map((option) => (option === ".+" ? shape.replace(/\\\$$/, "") : shape) + option + escape(chunks[index + 1])));
  });
  return shapes.map((shape) => new RegExp(`^${shape}$`, "s"));
}

/**
 * A template can also be covered by patterns working together ("The odds
 * changed: {changes}." holding "{pick} is now {odds}"), which only shows
 * when a real-looking message goes through the translator.
 */
function fitsSample({ chunks, exprs }) {
  const sample = chunks.reduce((text, chunk, index) => {
    if (index === 0) return chunk;
    const pick = /^[^"`]*\?\s*"([^"]*)"\s*:\s*"([^"]*)"\s*$/.exec(exprs[index - 1]);
    return text + (pick ? pick[1] : "Tirana") + chunk;
  }, "");
  return translateSq(sample) !== sample;
}

function* apiSources(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* apiSources(path);
    else if (entry.endsWith(".ts")) yield path;
  }
}

const apiMissing = [];
let apiCount = 0;
for (const file of apiSources(apiRoot)) {
  const name = file.slice(apiRoot.length + 1);
  if (API_SKIP_FILES.test(name)) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  for (const literal of literals(lines.join("\n"))) {
    if (literal.nested) continue;
    const first = literal.kind === "string" ? literal.text : literal.chunks[0];
    const shownToUsers = /(Exception\(|message:)\s*$/.test(literal.before) || (/^[A-Z]/.test(first) && /\s/.test(literal.chunks?.join("") ?? literal.text));
    if (!shownToUsers || API_SKIP_TEXT.has(literal.text) || API_SKIP_LINE.test(lines[literal.line - 1])) continue;
    if (/^(SELECT|UPDATE|INSERT|DELETE|WITH|WHERE|AND|OR)\b/.test(first)) continue;
    // API docs (Swagger), for developers.
    if (/@?Api\w+\(\{[^}]*description:\s*$/.test(literal.before)) continue;
    // API-Football's own names, which the odds code matches on, not text anyone sees.
    if (name === "odds/api-football.ts" && /(\[\s*|read\(\w+,\s*|throw new Error\(\s*|order:\s*)$/.test(literal.before)) continue;
    // The same for API-Sports' volleyball and handball bet names, looked up with bet(…) or listed as [["Name"], …].
    if (/^odds\/(volleyball|handball)\.ts$/.test(name) && /(\[\s*\[\s*|\bbet\(\s*)$/.test(literal.before)) continue;
    apiCount++;
    const covered =
      literal.kind === "string"
        ? literal.text in dict || translateSq(literal.text) !== literal.text
        : templateShapes(literal.chunks, literal.exprs).some((regex) => patternKeys.some((key) => regex.test(key))) || fitsSample(literal);
    if (!covered) apiMissing.push(`MISSING   api/src/${name}:${literal.line}: ${literal.kind === "string" ? JSON.stringify(literal.text) : "`" + literal.text + "`"}`);
  }
}
for (const line of apiMissing) console.log(line);
console.log(`${apiCount} texts in the API, ${apiMissing.length} missing.`);

process.exit(missing.length || apiMissing.length ? 1 : 0);
