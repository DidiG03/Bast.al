import type { Lang } from "./core";

/**
 * Competition names come from the feed in English ("Premier League",
 * "FA Cup", "UEFA Nations League"). In Albanian the common words in them are
 * translated and the proper names kept: "Premier League" → "Premier Liga",
 * "Cup" → "Kupa", "World Cup - Qualification Europe" → "Kupa e Botës -
 * Kualifikimet Evropa". Longest phrases first, whole words only.
 */
/** Country adjectives in competition names, as Albanian puts them after the noun ("Kampionati australian"). */
const ADJECTIVES: Record<string, string> = {
  Australian: "australian",
  English: "anglez",
  Scottish: "skocez",
  Welsh: "uellsian",
  Irish: "irlandez",
  Spanish: "spanjoll",
  Italian: "italian",
  German: "gjerman",
  French: "francez",
  Dutch: "holandez",
  Belgian: "belg",
  Portuguese: "portugez",
  Turkish: "turk",
  Greek: "grek",
  Brazilian: "brazilian",
  Argentine: "argjentinas",
  Mexican: "meksikan",
  American: "amerikan",
  Japanese: "japonez",
  Chinese: "kinez",
  Saudi: "saudit",
  Indian: "indian",
};
const ADJECTIVE = Object.keys(ADJECTIVES).join("|");
const NUMBER: Record<string, string> = { One: "1", Two: "2", Three: "3" };

const SQ: Array<[RegExp, string | ((...parts: string[]) => string)]> = [
  // Confederations' club competitions: the competition first, then whose it is ("Liga e Kampionëve AFC 2").
  // A country's adjective and a noun: the noun first ("Australian Championship" → "Kampionati australian").
  [new RegExp(`\\b(${ADJECTIVE}) (Championship|League|Cup|Super Cup)(?: (One|Two|Three))?\\b`, "g"), (_m, adjective, noun, tier) => `${{ Championship: "Kampionati", League: "Liga", Cup: "Kupa", "Super Cup": "Superkupa" }[noun]}${tier ? ` ${NUMBER[tier]}` : ""} ${ADJECTIVES[adjective]}`],
  [/\b(UEFA|AFC|CAF|CONCACAF|OFC) Champions Cup\b/g, (_m, body) => `Kupa e Kampionëve ${body}`],
  [/\bWomen'?s? Super League\b/g, "Superliga e femrave"],
  [/\b(UEFA|AFC|CAF|CONCACAF|OFC) Champions League(?: (Two|Elite))?\b/g, (_m, body, tier) => `Liga e Kampionëve ${body}${tier ? ` ${NUMBER[tier] ?? tier}` : ""}`],
  [/\b(UEFA|AFC|CAF|CONCACAF) Europa League\b/g, (_m, body) => `Liga e Evropës ${body}`],
  [/\bUEFA Europa Conference League\b/g, "Liga e Konferencës UEFA"],
  [/\bUEFA Conference League\b/g, "Liga e Konferencës UEFA"],
  [/\bUEFA Nations League\b/g, "Liga e Kombeve UEFA"],
  [/\b(AFC|CAF|CONCACAF) Cup\b/g, (_m, body) => `Kupa ${body}`],
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
  // "League One" / "League Two": "Liga 1" / "Liga 2".
  [/\bLeague (One|Two|Three)\b/g, (_m, n) => `Liga ${NUMBER[n]}`],
  [/\bFriendlies Clubs\b/g, "Miqësore klubesh"],
  [/\bFriendlies Women\b/g, "Miqësore femrash"],
  [/\bFriendlies\b/g, "Miqësore"],
  [/\bQualification\b/g, "Kualifikimet"],
  [/\bPlay-?offs\b/gi, "Play-off"],
  [/\bChampionship\b/g, "Kampionati"],
  [/\bDivision\b/g, "Divizioni"],
  // "FA Cup", "Emperor Cup": "Kupa FA", "Kupa Emperor".
  [/\b([A-Z][A-Za-z.]*) Cup\b/g, (_m, name) => `Kupa ${name}`],
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
  return SQ.reduce((text, [pattern, word]) => text.replace(pattern, word as never), name);
}
