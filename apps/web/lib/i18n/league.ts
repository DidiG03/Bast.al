import type { Lang } from "./core";

/**
 * Competition names come from the feed in English ("Premier League",
 * "FA Cup", "UEFA Nations League"). In Albanian the common words in them are
 * translated and the proper names kept: "Premier League" → "Premier Liga",
 * "Cup" → "Kupa", "World Cup - Qualification Europe" → "Kupa e Botës -
 * Kualifikimet Evropa". Longest phrases first, whole words only.
 */
const SQ: Array<[RegExp, string]> = [
  [/\bUEFA Nations League\b/g, "UEFA Liga e Kombeve"],
  [/\bNations League\b/g, "Liga e Kombeve"],
  [/\bChampions League\b/g, "Liga e Kampionëve"],
  [/\bEuropa Conference League\b/g, "Liga e Konferencës Evropiane"],
  [/\bConference League\b/g, "Liga e Konferencës"],
  [/\bEuropa League\b/g, "Liga e Evropës"],
  [/\bWorld Cup\b/g, "Kupa e Botës"],
  [/\bSuper Cup\b/g, "Superkupa"],
  [/\bSuper League\b/g, "Superliga"],
  [/\bPremier League\b/g, "Premier Liga"],
  [/\bLeague Cup\b/g, "Kupa e Ligës"],
  [/\bFriendlies Clubs\b/g, "Miqësore klubesh"],
  [/\bFriendlies Women\b/g, "Miqësore femrash"],
  [/\bFriendlies\b/g, "Miqësore"],
  [/\bQualification\b/g, "Kualifikimet"],
  [/\bPlay-?offs\b/gi, "Play-off"],
  [/\bChampionship\b/g, "Kampionati"],
  [/\bDivision\b/g, "Divizioni"],
  [/\bLeague\b/g, "Liga"],
  [/\bCup\b/g, "Kupa"],
  [/\bWomen\b/g, "Femrat"],
  [/\bReserve League\b/g, "Liga e rezervave"],
  [/\bYouth\b/g, "Të rinjtë"],
  [/\bEurope\b/g, "Evropa"],
  [/\bSouth America\b/g, "Amerika e Jugut"],
  [/\bAfrica\b/g, "Afrika"],
  [/\bAsia\b/g, "Azia"],
  [/\bGroup\b/g, "Grupi"],
];

export function translateLeague(lang: Lang, name: string | null | undefined): string {
  if (!name) return "";
  if (lang !== "sq") return name;
  return SQ.reduce((text, [pattern, word]) => text.replace(pattern, word), name);
}
