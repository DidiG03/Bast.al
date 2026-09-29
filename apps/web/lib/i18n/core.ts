import { sq } from "./sq";

/**
 * Translation for the whole app. English text is written in the code as it
 * is and doubles as the lookup key; `sq.ts` maps it to Albanian. Anything
 * missing from the dictionary falls back to English rather than breaking.
 *
 * - `translate` is for text in the app itself, with `{name}` placeholders.
 * - `translateServer` is for text the API sends (errors, notifications,
 *   ledger entries, market and pick names from the odds feed). The API keeps
 *   English, so the database and audit log stay in one language; dictionary
 *   keys with `{placeholders}` match those messages as patterns, and the parts
 *   they capture are translated too ("Finland / Draw" → "Finland / Barazim").
 */
export type Lang = "sq" | "en";
export type Vars = Record<string, string | number>;

export const DEFAULT_LANG: Lang = "sq";
export const LANG_COOKIE = "bastal-lang";

/**
 * Marks English text kept in data (menu items, labels in a lookup table) as
 * translatable. It returns the text unchanged; translate it with `t` where
 * it's shown. The checker script looks for these.
 */
export const msg = (text: string) => text;

export function parseLang(value: string | null | undefined): Lang {
  return value === "en" || value === "sq" ? value : DEFAULT_LANG;
}

function fill(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

export function translate(lang: Lang, text: string, vars?: Vars): string {
  return fill(lang === "sq" ? sq[text] ?? text : text, vars);
}

/** Albanian, like English, has one form for exactly 1 and another for everything else. `{count}` is filled in. */
export function translatePlural(lang: Lang, count: number, one: string, other: string, vars?: Vars): string {
  return translate(lang, count === 1 ? one : other, { count, ...vars });
}

type Pattern = { regex: RegExp; names: string[]; target: string };
let patterns: Pattern[] | null = null;
const serverCache = new Map<string, string>();

function compilePatterns(): Pattern[] {
  const compiled = Object.entries(sq)
    .filter(([key]) => /\{\w+\}/.test(key))
    .map(([key, target]) => {
      const names: string[] = [];
      const source = key
        .split(/(\{\w+\})/)
        .map((part) => {
          const name = /^\{(\w+)\}$/.exec(part)?.[1];
          if (name) {
            names.push(name);
            return "(.+?)";
          }
          return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("");
      // The more fixed text a pattern has, the more specific it is, so it's tried first.
      const literal = key.replace(/\{\w+\}/g, "").length;
      return { regex: new RegExp(`^${source}$`, "s"), names, target, literal };
    })
    .sort((a, b) => b.literal - a.literal);
  return compiled.map(({ regex, names, target }) => ({ regex, names, target }));
}

export function translateServer(lang: Lang, text: string | null | undefined, depth = 0): string {
  if (!text) return text ?? "";
  if (lang === "en") return text;
  const exact = sq[text];
  if (exact !== undefined) return exact;
  if (depth === 0 && serverCache.has(text)) return serverCache.get(text)!;
  let result = text;
  if (depth < 4) {
    patterns ??= compilePatterns();
    for (const pattern of patterns) {
      const match = pattern.regex.exec(text);
      if (!match) continue;
      const vars: Vars = {};
      pattern.names.forEach((name, index) => (vars[name] = translateServer(lang, match[index + 1], depth + 1)));
      result = fill(pattern.target, vars);
      break;
    }
  }
  if (depth === 0) {
    if (serverCache.size > 5000) serverCache.clear();
    serverCache.set(text, result);
  }
  return result;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Dates and times in the reader's language, with a 24-hour clock in Albanian. */
export function formatDate(lang: Lang, value: Date | string | number, options: Intl.DateTimeFormatOptions): string {
  const key = `${lang}:${JSON.stringify(options)}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    const withClock = lang === "sq" && (options.hour !== undefined || options.timeStyle !== undefined) ? { hourCycle: "h23" as const, ...options } : options;
    formatter = new Intl.DateTimeFormat(lang === "sq" ? "sq-AL" : "en", withClock);
    formatters.set(key, formatter);
  }
  return formatter.format(new Date(value));
}

/**
 * The language in this browser tab, for code outside React (apiFetch turning
 * API errors into the reader's language). Set by I18nProvider in the browser
 * only; on the server every request can differ, so it's never set there.
 */
let browserLang: Lang | null = null;
export function setBrowserLang(lang: Lang) {
  browserLang = lang;
}
export function currentBrowserLang(): Lang {
  return browserLang ?? DEFAULT_LANG;
}
