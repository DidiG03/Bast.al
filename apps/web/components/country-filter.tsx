"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useI18n } from "./i18n-provider";

export type CountryOption = {
  /** The country as the feed names it: what the filter matches on. */
  country: string;
  /** In the reader's language. */
  label: string;
  /** The feed's flag picture, or null (then `emoji` stands in). */
  flag: string | null;
  emoji: string;
  /** Matches on the list from this country. */
  count: number;
};

/**
 * The Bet page's country filter: a button that opens a list of the
 * countries with matches, each with its flag and name, any number of which
 * can be ticked. Nothing ticked means every country.
 */
export function CountryFilter({ options, selected, onChange }: { options: CountryOption[]; selected: ReadonlySet<string>; onChange: (next: Set<string>) => void }) {
  const { t, tn } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | TouchEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((option) => option.label.toLowerCase().includes(q) || option.country.toLowerCase().includes(q)) : options;
  }, [options, query]);

  const picked = options.filter((option) => selected.has(option.country));
  const label = picked.length === 0 ? t("Countries") : picked.length === 1 ? picked[0].label : tn(picked.length, "{count} country", "{count} countries");

  const toggle = (country: string) => {
    const next = new Set(selected);
    if (next.has(country)) next.delete(country);
    else next.add(country);
    onChange(next);
  };

  return (
    <div className="country-filter" ref={box}>
      <button type="button" className={`country-filter-button${picked.length > 0 ? " is-active" : ""}`} onClick={() => setOpen((was) => !was)} aria-expanded={open} aria-controls={listId} aria-label={picked.length === 0 ? t("All countries") : `${t("Countries")}: ${label}`} title={label}>
        {picked.length > 0 ? (
          <span className="country-filter-flags" aria-hidden="true">
            {picked.slice(0, 2).map((option) => (
              <Flag key={option.country} option={option} />
            ))}
          </span>
        ) : (
          <svg className="country-filter-globe" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3Z" />
          </svg>
        )}
      </button>
      {open ? (
        <div className="country-filter-panel" id={listId} role="group" aria-label={t("Countries")}>
          {options.length > 10 ? (
            <input
              type="search"
              className="country-filter-search"
              placeholder={t("Search countries")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t("Search countries")}
              // No autoFocus: on phones that would open the keyboard and zoom the page.
            />
          ) : null}
          <ul className="country-filter-list">
            {shown.map((option) => {
              const on = selected.has(option.country);
              return (
                <li key={option.country}>
                  <label className={`country-filter-row${on ? " is-on" : ""}`}>
                    <input type="checkbox" checked={on} onChange={() => toggle(option.country)} />
                    <Flag option={option} />
                    <span className="country-filter-name">{option.label}</span>
                    <span className="country-filter-count">{option.count}</span>
                  </label>
                </li>
              );
            })}
            {shown.length === 0 ? <li className="country-filter-empty muted">{t("No country matches.")}</li> : null}
          </ul>
          <div className="country-filter-foot">
            <button type="button" className="text-button" onClick={() => onChange(new Set())} disabled={selected.size === 0}>
              {t("Clear")}
            </button>
            <button type="button" className="country-filter-done" onClick={() => setOpen(false)}>
              {t("Show matches")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Flag({ option }: { option: CountryOption }) {
  const [broken, setBroken] = useState(false);
  if (option.flag && !broken) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="country-flag" src={option.flag} alt="" width={20} height={14} loading="lazy" onError={() => setBroken(true)} />;
  }
  return (
    <span className="country-flag is-emoji" aria-hidden="true">
      {option.emoji}
    </span>
  );
}
