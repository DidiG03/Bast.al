import { cookies } from "next/headers";
import { formatDate, LANG_COOKIE, parseLang, translate, translatePlural, translateServer, type Lang, type Vars } from "./core";

/** The reader's language in a server component, from their cookie (Albanian unless they picked English). */
export function getLang(): Lang {
  return parseLang(cookies().get(LANG_COOKIE)?.value);
}

/** `t` for server components. */
export function getT() {
  const lang = getLang();
  return {
    lang,
    t: (text: string, vars?: Vars) => translate(lang, text, vars),
    tn: (count: number, one: string, other: string, vars?: Vars) => translatePlural(lang, count, one, other, vars),
    ts: (text: string | null | undefined) => translateServer(lang, text),
    date: (value: Date | string | number, options: Intl.DateTimeFormatOptions) => formatDate(lang, value, options),
  };
}
