/**
 * Finding our match (from API-Football) in the live tracker provider's
 * fixture list, by team names and kickoff time. A wrong tracker on a match
 * is worse than none, so this only answers when it is sure: both names
 * close, kickoff within a few minutes, and no second fixture nearly as good.
 */

export interface TrackerCandidate {
  externalId: string;
  homeTeam: string;
  awayTeam: string;
  kickoff: Date;
}

export interface TrackerTarget {
  homeTeam: string | null;
  awayTeam: string | null;
  startsAt: Date;
}

/** Kickoffs further apart than this are different matches. */
export const KICKOFF_TOLERANCE_MS = 15 * 60_000;
/** Lowest name score (the weaker of the two teams) we accept. */
export const MIN_NAME_SCORE = 0.85;
/**
 * One team clearly the same and the kickoff within a few minutes: then the
 * other name only needs to be close ("Central Cordoba de Santiago" vs
 * "Central Cordoba SDE"). A team doesn't play two matches at once.
 */
export const SURE_TEAM_SCORE = 0.9;
export const OTHER_TEAM_SCORE = 0.6;
export const SAME_KICKOFF_MS = 5 * 60_000;
/** The best fixture must beat the runner-up by this much, or we don't pick. */
export const MIN_LEAD = 0.08;

/** Words that say nothing about which club it is. */
const FILLER = new Set(["fc", "cf", "sc", "afc", "ac", "as", "cd", "ss", "sk", "fk", "nk", "kf", "ks", "bk", "sv", "club", "de", "the", "calcio", "futbol", "football"]);
/** Same word, other spelling. */
const SAME: Record<string, string> = { utd: "united", st: "saint", munchen: "munich", internazionale: "inter" };
/** Words that make it a different team of the same club: they must match on both sides. */
const SIDE = /^(w|women|womens|fem|femenino|feminine|u\d{2}|ii|iii|b|reserves|youth)$/;

/**
 * Countries known by more than one name. Each spelling (normalised: no
 * accents, lower case, words only) maps to one name; API-Football and
 * SportScore don't always use the same one ("Czech Republic" / "Czechia").
 */
const COUNTRY_NAMES: Array<[string, string[]]> = [
  ["czech republic", ["czechia", "czech rep", "czech"]],
  ["turkey", ["turkiye", "tuerkiye"]],
  ["south korea", ["korea republic", "republic of korea", "korea rep", "korea"]],
  ["north korea", ["korea dpr", "dpr korea", "korea dpr north"]],
  ["usa", ["united states", "united states of america", "us"]],
  ["ivory coast", ["cote d ivoire", "cote divoire"]],
  ["cape verde", ["cabo verde", "cape verde islands"]],
  ["iran", ["ir iran", "iran ir"]],
  ["china", ["china pr", "pr china"]],
  ["bosnia and herzegovina", ["bosnia herzegovina", "bosnia", "bosnia hercegovina"]],
  ["north macedonia", ["macedonia", "fyr macedonia"]],
  ["republic of ireland", ["ireland", "rep of ireland", "eire"]],
  ["dr congo", ["congo dr", "dr congo", "democratic republic of congo", "congo democratic republic"]],
  ["eswatini", ["swaziland"]],
  ["kyrgyzstan", ["kyrgyz republic"]],
  ["netherlands", ["holland"]],
  ["chinese taipei", ["taiwan"]],
  ["timor leste", ["east timor"]],
  ["gambia", ["the gambia"]],
  ["brunei", ["brunei darussalam"]],
  ["vietnam", ["viet nam"]],
  ["laos", ["lao pdr", "lao"]],
  ["saint kitts and nevis", ["st kitts and nevis", "saint kitts nevis", "st kitts nevis"]],
  ["saint vincent and the grenadines", ["st vincent and the grenadines", "st vincent grenadines"]],
  ["saint lucia", ["st lucia"]],
  ["united arab emirates", ["uae"]],
  ["russia", ["russian federation"]],
  ["syria", ["syrian arab republic"]],
  ["palestine", ["state of palestine"]],
  ["sao tome and principe", ["sao tome e principe"]],
  ["curacao", ["curacao"]],
];
const COUNTRY = new Map<string, string>();
for (const [name, others] of COUNTRY_NAMES) for (const spelling of [name, ...others]) COUNTRY.set(spelling, name);

/** The other names a team (a country) goes by, its own first: for asking SportScore by name. */
export function otherNames(name: string): string[] {
  const words = nameTokens(name, false).core.join(" ");
  const country = COUNTRY.get(words);
  if (!country) return [name];
  const all = COUNTRY_NAMES.find(([key]) => key === country)!;
  return [name, ...[all[0], ...all[1]].filter((spelling) => spelling !== words)];
}

export function nameTokens(name: string, countries = true): { core: string[]; side: string[] } {
  const words = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => SAME[word] ?? word);
  const side = words.filter((word) => SIDE.test(word)).map((word) => (word.startsWith("w") || word.startsWith("fem") ? "women" : word)).sort();
  let core = words.filter((word) => !SIDE.test(word) && !FILLER.has(word));
  if (core.length === 0) core = words.filter((word) => !SIDE.test(word));
  // One name for a country, whichever spelling ("Czechia" and "Czech Republic" are the same side).
  const country = countries ? COUNTRY.get(core.join(" ")) : undefined;
  return { core: country ? country.split(" ") : core, side };
}

function bigrams(text: string): Map<string, number> {
  const grams = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i += 1) grams.set(text.slice(i, i + 2), (grams.get(text.slice(i, i + 2)) ?? 0) + 1);
  return grams;
}

function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const left = bigrams(a);
  const right = bigrams(b);
  let shared = 0;
  for (const [gram, count] of left) shared += Math.min(count, right.get(gram) ?? 0);
  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

/** 0–1: how sure we are two team names are the same team. */
export function teamScore(a: string, b: string): number {
  const left = nameTokens(a);
  const right = nameTokens(b);
  // A women's or youth side is never the senior team.
  if (left.side.join(" ") !== right.side.join(" ")) return 0;
  const x = left.core.join(" ");
  const y = right.core.join(" ");
  if (x === y) return 1;
  // "Wolverhampton Wanderers" vs "Wolverhampton": every word of the short name is in the long one.
  const [short, long] = left.core.length <= right.core.length ? [left.core, right.core] : [right.core, left.core];
  if (short.length > 0 && short.every((word) => long.includes(word)) && short.join("").length >= 4) return 0.9;
  return dice(x.replace(/ /g, ""), y.replace(/ /g, ""));
}

export interface TrackerMatch {
  externalId: string;
  confidence: number;
}

/** The candidate that is surely this match, or null. */
export function matchTrackerFixture(target: TrackerTarget, candidates: TrackerCandidate[]): TrackerMatch | null {
  if (!target.homeTeam || !target.awayTeam) return null;
  const scored = candidates
    .filter((candidate) => Math.abs(candidate.kickoff.getTime() - target.startsAt.getTime()) <= KICKOFF_TOLERANCE_MS)
    .map((candidate) => {
      const home = teamScore(target.homeTeam!, candidate.homeTeam);
      const away = teamScore(target.awayTeam!, candidate.awayTeam);
      const sameKickoff = Math.abs(candidate.kickoff.getTime() - target.startsAt.getTime()) <= SAME_KICKOFF_MS;
      const oneSure = Math.max(home, away) >= SURE_TEAM_SCORE && Math.min(home, away) >= OTHER_TEAM_SCORE && sameKickoff;
      return { candidate, score: Math.max(Math.min(home, away), oneSure ? MIN_NAME_SCORE : 0) };
    })
    .sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  if (!best || best.score < MIN_NAME_SCORE) return null;
  if (next && best.score - next.score < MIN_LEAD) return null;
  return { externalId: best.candidate.externalId, confidence: Math.round(best.score * 1000) / 1000 };
}
