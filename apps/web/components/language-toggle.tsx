"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n-provider";

const NAMES = { sq: "Shqip", en: "English" } as const;

/** The language in use (SQ or EN); a tap opens both, with a tick on the one in use. */
export function LanguageToggle() {
  const { lang, setLang } = useI18n();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => !box.current?.contains(event.target as Node) && setOpen(false);
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="language-menu" ref={box}>
      <button
        type="button"
        className="secondary language-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Gjuha / Language: ${NAMES[lang]}`}
        title="Gjuha / Language"
      >
        <span aria-hidden="true">{lang.toUpperCase()}</span>
      </button>
      {open ? (
        <div className="language-menu-list" role="menu">
          {(["sq", "en"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="menuitemradio"
              aria-checked={option === lang}
              lang={option}
              className={option === lang ? "is-active" : undefined}
              onClick={() => {
                setOpen(false);
                if (option !== lang) setLang(option);
              }}
            >
              <span>{NAMES[option]}</span>
              <span className="language-menu-check" aria-hidden="true">{option === lang ? "✓" : ""}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Both languages side by side, for the Security page. */
export function LanguagePicker() {
  const { lang, setLang } = useI18n();
  return (
    <div className="row language-picker" role="group" aria-label="Gjuha / Language">
      {(["sq", "en"] as const).map((option) => (
        <button key={option} type="button" className={option === lang ? undefined : "secondary"} aria-pressed={option === lang} onClick={() => option !== lang && setLang(option)} lang={option}>
          {NAMES[option]}
        </button>
      ))}
    </div>
  );
}
