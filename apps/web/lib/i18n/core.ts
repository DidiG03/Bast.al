import { TIME_ZONE } from "../time";
import { createServerTranslator } from "./match";
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

const translateSq = createServerTranslator(sq);

export function translateServer(lang: Lang, text: string | null | undefined): string {
  if (!text) return text ?? "";
  return lang === "en" ? text : translateSq(text);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

const SQ_MONTHS = ["janar", "shkurt", "mars", "prill", "maj", "qershor", "korrik", "gusht", "shtator", "tetor", "nëntor", "dhjetor"];
const SQ_MONTHS_SHORT = ["jan", "shk", "mar", "pri", "maj", "qer", "korr", "gush", "sht", "tet", "nën", "dhj"];
const SQ_DAYS = ["e diel", "e hënë", "e martë", "e mërkurë", "e enjte", "e premte", "e shtunë"];
const SQ_DAYS_SHORT = ["Die", "Hën", "Mar", "Mër", "Enj", "Pre", "Sht"];

/** Whether this browser or server knows Albanian dates. Chrome ships without them and quietly uses English. */
let sqSupported: boolean | null = null;
function knowsAlbanian(): boolean {
  if (sqSupported === null) sqSupported = new Intl.DateTimeFormat("sq-AL").resolvedOptions().locale.startsWith("sq");
  return sqSupported;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dayAndMonthFormats = new Map<string, Intl.DateTimeFormat>();

/** The weekday (0 = Sunday) and month (0 = January) a moment falls on in a time zone. */
function dayAndMonth(date: Date, timeZone: string): { weekday: number; month: number } {
  let format = dayAndMonthFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "numeric" });
    dayAndMonthFormats.set(timeZone, format);
  }
  const parts = format.formatToParts(date);
  return {
    weekday: WEEKDAYS.indexOf(parts.find((part) => part.type === "weekday")?.value ?? ""),
    month: Number(parts.find((part) => part.type === "month")?.value) - 1,
  };
}

/**
 * Albanian dates without Albanian locale data: the parts from en-GB (which
 * puts the day before the month, like Albanian), with the day and month
 * names swapped for Albanian ones.
 */
function albanianParts(formatter: Intl.DateTimeFormat, options: Intl.DateTimeFormatOptions, date: Date): string {
  const parts = formatter.formatToParts(date);
  const { weekday, month } = dayAndMonth(date, formatter.resolvedOptions().timeZone);
  return parts
    .map((part, index) => {
      if (part.type === "weekday") return options.weekday === "long" ? SQ_DAYS[weekday] : SQ_DAYS_SHORT[weekday];
      if (part.type === "month" && (options.month === "long" || options.month === "short")) return (options.month === "long" ? SQ_MONTHS : SQ_MONTHS_SHORT)[month];
      // "e premte, 2 tetor": a comma after the day's name.
      if (part.type === "literal" && parts[index - 1]?.type === "weekday" && !part.value.includes(",")) return `,${part.value}`;
      return part.value;
    })
    .join("");
}

/**
 * Dates and times in the reader's language, with a 24-hour clock in
 * Albanian, on Albanian time (TIME_ZONE) unless the options name another
 * zone: the same on the server, which runs on UTC, as in any browser.
 */
export function formatDate(lang: Lang, value: Date | string | number, requested: Intl.DateTimeFormatOptions): string {
  const fallback = lang === "sq" && !knowsAlbanian();
  const zoned = { timeZone: TIME_ZONE, ...requested };
  // dateStyle/timeStyle can't be taken apart by name, so without Albanian data they're spelled out.
  const options = fallback ? spelledOut(zoned) : zoned;
  const key = `${lang}:${fallback}:${JSON.stringify(options)}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    const withClock = lang === "sq" && (options.hour !== undefined || options.timeStyle !== undefined) ? { hourCycle: "h23" as const, ...options } : options;
    formatter = new Intl.DateTimeFormat(lang === "sq" ? (fallback ? "en-GB" : "sq-AL") : "en", withClock);
    formatters.set(key, formatter);
  }
  const date = new Date(value);
  return fallback ? albanianParts(formatter, options, date) : formatter.format(date);
}

function spelledOut(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions {
  const { dateStyle, timeStyle, ...rest } = options;
  if (!dateStyle && !timeStyle) return options;
  const date: Intl.DateTimeFormatOptions = !dateStyle
    ? {}
    : dateStyle === "short"
      ? { day: "2-digit", month: "2-digit", year: "numeric" }
      : { day: "numeric", month: dateStyle === "medium" ? "short" : "long", year: "numeric", ...(dateStyle === "full" ? { weekday: "long" as const } : {}) };
  const time: Intl.DateTimeFormatOptions = timeStyle ? { hour: "2-digit", minute: "2-digit", ...(timeStyle === "short" ? {} : { second: "2-digit" as const }) } : {};
  return { ...rest, ...date, ...time };
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
