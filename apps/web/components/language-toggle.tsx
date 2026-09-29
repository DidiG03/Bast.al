"use client";

import { useI18n } from "./i18n-provider";

/** Switches between Albanian and English. Shows the language it switches to. */
export function LanguageToggle() {
  const { lang, setLang } = useI18n();
  const next = lang === "sq" ? "en" : "sq";
  const label = next === "en" ? "Switch to English" : "Kalo në shqip";

  return (
    <button type="button" className="secondary language-toggle" onClick={() => setLang(next)} aria-label={label} title={label} lang={next}>
      <span aria-hidden="true">{next.toUpperCase()}</span>
    </button>
  );
}

/** Both languages side by side, for the Security page. */
export function LanguagePicker() {
  const { lang, setLang } = useI18n();
  return (
    <div className="row language-picker" role="group" aria-label="Gjuha / Language">
      {(["sq", "en"] as const).map((option) => (
        <button key={option} type="button" className={option === lang ? undefined : "secondary"} aria-pressed={option === lang} onClick={() => option !== lang && setLang(option)} lang={option}>
          {option === "sq" ? "Shqip" : "English"}
        </button>
      ))}
    </div>
  );
}
