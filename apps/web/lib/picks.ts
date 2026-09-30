import type { I18n } from "../components/i18n-provider";

/**
 * A pick's name in plain words. Over/under picks say the count that wins
 * ("Over 2.5" → "3 or more"), since the half-goal line confuses people;
 * everything else is the server's name in the reader's language.
 */
export function pickLabel(name: string, { t, ts }: Pick<I18n, "t" | "ts">): string {
  const line = /^(Over|Under) (\d+)\.5$/.exec(name);
  if (!line) return ts(name);
  const whole = Number(line[2]);
  if (line[1] === "Over") return t("{count} or more", { count: whole + 1 });
  return whole === 0 ? t("None") : t("{count} or fewer", { count: whole });
}
