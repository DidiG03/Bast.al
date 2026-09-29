"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { formatDate, LANG_COOKIE, setBrowserLang, translate, translatePlural, translateServer, type Lang, type Vars } from "../lib/i18n/core";

export type I18n = {
  lang: Lang;
  /** App text: `t("Sign out")`, `t("Hello {name}", { name })`. */
  t: (text: string, vars?: Vars) => string;
  /** App text that depends on a number: `tn(n, "{count} bet", "{count} bets")`. */
  tn: (count: number, one: string, other: string, vars?: Vars) => string;
  /** Text that came from the API: errors, notifications, market and pick names. */
  ts: (text: string | null | undefined) => string;
  /** A date or time in the reader's language. */
  date: (value: Date | string | number, options: Intl.DateTimeFormatOptions) => string;
  /** Switches language and reloads, so every page (server-rendered parts included) follows. */
  setLang: (lang: Lang) => void;
};

function make(lang: Lang): I18n {
  return {
    lang,
    t: (text, vars) => translate(lang, text, vars),
    tn: (count, one, other, vars) => translatePlural(lang, count, one, other, vars),
    ts: (text) => translateServer(lang, text),
    date: (value, options) => formatDate(lang, value, options),
    setLang: (next) => {
      document.cookie = `${LANG_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
      window.location.reload();
    },
  };
}

const I18nContext = createContext<I18n>(make("sq"));

export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  if (typeof window !== "undefined") setBrowserLang(lang);
  const value = useMemo(() => make(lang), [lang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  return useContext(I18nContext);
}
