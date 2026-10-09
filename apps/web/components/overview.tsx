import Link from "next/link";
import type { ReactNode } from "react";
import type { NotificationItem } from "../lib/api";
import { HelpTip } from "./help-tip";
import { NamedIcon, type IconName } from "./icons";
import { getT } from "../lib/i18n/server";

/** A framed block: a quiet header strip with the title, and the content on a raised inner sheet. */
export function Panel({
  title,
  icon,
  action,
  children,
  className = "",
  flush = false,
  help,
}: {
  title: string;
  /** English: what this card shows and how it works, behind the "!" by the title. */
  help?: string;
  icon?: IconName;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Let tables and lists run to the sheet's edges. */
  flush?: boolean;
}) {
  return (
    <section className={`panel ${className}`}>
      <header className="panel-head">
        <h2>
          {icon ? <NamedIcon name={icon} className="panel-icon" /> : null}
          {title}
          {help ? <HelpTip text={help} /> : null}
        </h2>
        {action ? <div className="panel-action">{action}</div> : null}
      </header>
      <div className={`panel-body${flush ? " is-flush" : ""}`}>{children}</div>
    </section>
  );
}

export type Delta = { current: number; previous: number; label: string };

/** "+7.1%" against the same stretch of the previous period, or nothing when there is no baseline. */
type Tone = "good" | "bad" | "neutral";

function deltaTone(delta: Delta, goodWhenUp: boolean): Tone {
  if (delta.previous === 0 || delta.current === delta.previous) return "neutral";
  return delta.current > delta.previous === goodWhenUp ? "good" : "bad";
}

function DeltaBadge({ delta, goodWhenUp = true }: { delta: Delta; goodWhenUp?: boolean }) {
  const { t } = getT();
  const { current, previous } = delta;
  if (previous === 0 && current === 0) return <span className="kpi-compare">{t("No change {label}", { label: delta.label })}</span>;
  if (previous === 0) return <span className="kpi-compare">{t("Nothing to compare with last week")}</span>;
  const change = (current - previous) / Math.abs(previous);
  const up = change >= 0;
  const tone = deltaTone(delta, goodWhenUp);
  const text = `${up ? "+" : "−"}${Math.abs(change * 100).toFixed(Math.abs(change) >= 10 ? 0 : 1)}%`;
  return (
    <span className="kpi-compare">
      <span className={`kpi-delta is-${tone}`}>{text}</span> {delta.label}
    </span>
  );
}

export function KpiCard({
  label,
  icon,
  value,
  delta,
  spark,
  hint,
  goodWhenUp,
  tone,
  help,
}: {
  label: string;
  /** English: what this number means, behind the "!" by the label. */
  help?: string;
  icon: IconName;
  value: string;
  delta?: Delta;
  spark?: number[];
  hint?: ReactNode;
  goodWhenUp?: boolean;
  /** Colour the figure itself, for amounts that can go below zero. */
  tone?: "good" | "bad";
}) {
  // The line takes the colour of the comparison below it, so the two never disagree.
  const sparkTone: Tone = delta ? deltaTone(delta, goodWhenUp ?? true) : "neutral";
  return (
    <section className="panel kpi">
      <header className="panel-head">
        <h2>
          {label}
          {help ? <HelpTip text={help} /> : null}
        </h2>
        <NamedIcon name={icon} className="panel-icon" />
      </header>
      <div className="panel-body kpi-body">
        <div className="kpi-main">
          <strong className={`kpi-value${tone ? ` is-${tone}` : ""}`}>{value}</strong>
          {spark && spark.some((point) => point !== 0) ? (
            <Sparkline points={spark} tone={sparkTone} />
          ) : null}
        </div>
        {delta ? <DeltaBadge delta={delta} goodWhenUp={goodWhenUp} /> : null}
        {hint ? <div className="kpi-hint">{hint}</div> : null}
      </div>
    </section>
  );
}

function Sparkline({ points, tone }: { points: number[]; tone: Tone }) {
  const width = 96;
  const height = 36;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const coords = points.map((point, index) => [index * step, height - 3 - ((point - min) / span) * (height - 6)] as const);
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `0,${height} ${line} ${width},${height}`;
  return (
    <svg className={`sparkline is-${tone}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon points={area} className="sparkline-area" />
      <polyline points={line} className="sparkline-line" />
    </svg>
  );
}

export type BarPoint = { label: string; value: number; detail: string; current?: boolean };

/** Rounds up to 1, 2, 2.5 or 5 times a power of ten, so axis labels stay readable. */
function niceCeiling(value: number): number {
  if (value <= 0) return 0;
  const power = 10 ** Math.floor(Math.log10(value));
  const scaled = value / power;
  const step = [1, 2, 2.5, 5, 10].find((candidate) => scaled <= candidate) ?? 10;
  return step * power;
}

const compactMoney = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });

function axisLabel(value: number) {
  if (value === 0) return "0";
  return `${value < 0 ? "−" : ""}${compactMoney.format(Math.abs(value))} ALL`;
}

/**
 * Columns with a zero line, so losing days hang below it. Hover or focus a
 * column to read its exact figure; the current period is drawn solid.
 */
export function BarChart({ points, summary }: { points: BarPoint[]; summary?: ReactNode }) {
  // Past seven columns the labels crowd a phone screen, so every other one hides there.
  const dense = points.length > 7;
  const top = niceCeiling(Math.max(0, ...points.map((point) => point.value)));
  const bottom = -niceCeiling(Math.max(0, ...points.map((point) => -point.value)));
  const range = top - bottom || 1;
  const zero = (top / range) * 100;
  const ticks = bottom < 0 ? [top, 0, bottom] : [top, top / 2, 0];

  return (
    <div className={`bar-chart${dense ? " is-dense" : ""}`}>
      {summary ? <div className="bar-chart-summary">{summary}</div> : null}
      <div className="bar-chart-plot">
        <div className="bar-chart-grid" aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick} style={{ top: `${((top - tick) / range) * 100}%` }}>
              <em>{axisLabel(tick)}</em>
            </span>
          ))}
        </div>
        <ol className="bar-chart-columns">
          {points.map((point) => {
            const size = (Math.abs(point.value) / range) * 100;
            const negative = point.value < 0;
            return (
              <li key={point.label} className={`bar-chart-column${point.current ? " is-current" : ""}`} tabIndex={0} aria-label={`${point.label}: ${point.detail}`}>
                <span
                  className={`bar-chart-bar${negative ? " is-negative" : ""}`}
                  style={negative ? { top: `${zero}%`, height: `${size}%` } : { bottom: `${100 - zero}%`, height: `${Math.max(size, point.value === 0 ? 0 : 1.5)}%` }}
                />
                <span className="bar-chart-tip" role="tooltip" style={{ bottom: `${Math.min(100 - zero + (negative ? 0 : size), 92)}%` }}>
                  {point.detail}
                </span>
                <span className="bar-chart-label">{point.label}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

export type AttentionItem = { label: string; count: number; href: string };

/** Things waiting on this person, across pages, so nothing gets missed. */
export function AttentionList({ items }: { items: AttentionItem[] }) {
  const { t } = getT();
  const active = items.filter((item) => item.count > 0);
  if (active.length === 0) {
    return (
      <p className="panel-empty">
        <NamedIcon name="check" className="panel-empty-icon" />
        {t("Nothing is waiting on you.")}
      </p>
    );
  }
  return (
    <ul className="attention">
      {active.map((item) => (
        <li key={item.href + item.label}>
          <Link href={item.href}>
            <span>{item.label}</span>
            <span className="count-badge">{item.count}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

const CATEGORY_ICONS: Record<NotificationItem["category"], IconName> = {
  FINANCE: "money",
  ACCOUNT: "users",
  SECURITY: "shield",
  SYSTEM: "info",
};

const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Tirane" };
const DAY: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", timeZone: "Europe/Tirane" };

function when(iso: string, now: Date) {
  const { date } = getT();
  return date(iso, DAY) === date(now, DAY) ? date(iso, TIME) : date(iso, DAY);
}

/** The latest notifications, newest first, as a quiet timeline. */
export function ActivityFeed({ items, now }: { items: NotificationItem[]; now: Date }) {
  const { t, ts } = getT();
  if (items.length === 0) return <p className="panel-empty">{t("No activity yet this week.")}</p>;
  return (
    <ol className="activity">
      {items.map((item) => (
        <li key={item.id} className={`activity-item is-${item.severity.toLowerCase()}`}>
          <span className="activity-icon">
            <NamedIcon name={CATEGORY_ICONS[item.category]} />
          </span>
          <div>
            <div className="activity-title">
              <strong>{ts(item.title)}</strong>
              <time dateTime={item.createdAt}>{when(item.createdAt, now)}</time>
            </div>
            <p>{ts(item.message)}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Label and value pairs, one per line, values right-aligned. */
export function Facts({ rows }: { rows: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="facts">
      {rows.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A thin bar for "how much of the limit is used". */
export function Meter({ share, label }: { share: number; label: string }) {
  const clamped = Math.min(Math.max(share, 0), 1);
  const tone = clamped >= 0.9 ? " is-bad" : clamped >= 0.7 ? " is-warn" : "";
  return (
    <div className={`meter${tone}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped * 100)} aria-label={label}>
      <span style={{ width: `${clamped * 100}%` }} />
    </div>
  );
}
