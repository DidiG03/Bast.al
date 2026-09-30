/**
 * Days and weeks run on Albanian time: a day starts at midnight in Tirana and
 * a week on Monday, summer time included. Daily loss limits reset then, and
 * commission weeks and the daily charts start then. BUSINESS_TIME_ZONE
 * changes it (an IANA name such as "Europe/Tirane").
 */
export const TIME_ZONE = process.env.BUSINESS_TIME_ZONE?.trim() || "Europe/Tirane";

const clockFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hourCycle: "h23",
});

/** The date and time on a clock in TIME_ZONE at this moment (month 1–12). */
function wallClock(at: Date) {
  const parts: Record<string, number> = {};
  for (const part of clockFormat.formatToParts(at)) if (part.type !== "literal") parts[part.type] = Number(part.value);
  return parts as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** How far TIME_ZONE's clocks are ahead of UTC at this moment, in milliseconds. */
function offsetAt(at: Date): number {
  const clock = wallClock(at);
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second) - Math.floor(at.getTime() / 1000) * 1000;
}

/** Midnight in TIME_ZONE at the start of this date (month 1–12; a day past the month's end rolls over). */
export function midnight(year: number, month: number, day: number): Date {
  const utc = Date.UTC(year, month - 1, day);
  // The offset at midnight itself, which differs from the one at UTC midnight on the days the clocks change.
  return new Date(utc - offsetAt(new Date(utc - offsetAt(new Date(utc)))));
}

/** The start of the day `at` falls on. */
export function startOfDay(at: Date): Date {
  const clock = wallClock(at);
  return midnight(clock.year, clock.month, clock.day);
}

/** Midnight `days` days after (or before, when negative) the day `at` falls on. A day with a clock change is 23 or 25 hours long. */
export function addDays(at: Date, days: number): Date {
  const clock = wallClock(at);
  return midnight(clock.year, clock.month, clock.day + days);
}

/** Monday 00:00 of the week `at` falls in. */
export function startOfWeek(at: Date): Date {
  const clock = wallClock(at);
  const weekday = new Date(Date.UTC(clock.year, clock.month - 1, clock.day)).getUTCDay();
  return midnight(clock.year, clock.month, clock.day - ((weekday + 6) % 7));
}

/** "31 Aug", on TIME_ZONE's calendar, for text the API writes (ledger reasons, errors). */
export const shortDay = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: TIME_ZONE });
