/**
 * Countries on the Bet page's country filter: each match's country as
 * API-Football names it (in English), shown in the reader's language with
 * its flag. Competitions with no country ("World": the Champions League, the
 * World Cup…) are grouped as International.
 */

/** API-Football's country names → ISO 3166 codes, for the name in the reader's language and a fallback flag. */
const ISO: Record<string, string> = {
  albania: "AL", algeria: "DZ", andorra: "AD", argentina: "AR", armenia: "AM", australia: "AU", austria: "AT", azerbaijan: "AZ",
  belarus: "BY", belgium: "BE", bolivia: "BO", "bosnia": "BA", "bosnia-and-herzegovina": "BA", brazil: "BR", bulgaria: "BG",
  canada: "CA", chile: "CL", china: "CN", colombia: "CO", "costa-rica": "CR", croatia: "HR", cyprus: "CY", "czech-republic": "CZ", czechia: "CZ",
  denmark: "DK", ecuador: "EC", egypt: "EG", estonia: "EE", "faroe-islands": "FO", finland: "FI", france: "FR",
  georgia: "GE", germany: "DE", ghana: "GH", greece: "GR", hungary: "HU", iceland: "IS", india: "IN", indonesia: "ID", iran: "IR", iraq: "IQ",
  ireland: "IE", israel: "IL", italy: "IT", japan: "JP", jordan: "JO", kazakhstan: "KZ", kosovo: "XK", "korea-republic": "KR", "south-korea": "KR",
  latvia: "LV", lithuania: "LT", luxembourg: "LU", malta: "MT", mexico: "MX", moldova: "MD", montenegro: "ME", morocco: "MA",
  netherlands: "NL", "new-zealand": "NZ", nigeria: "NG", "north-macedonia": "MK", macedonia: "MK", norway: "NO",
  paraguay: "PY", peru: "PE", poland: "PL", portugal: "PT", qatar: "QA", romania: "RO", russia: "RU",
  "san-marino": "SM", "saudi-arabia": "SA", senegal: "SN", serbia: "RS", singapore: "SG", slovakia: "SK", slovenia: "SI", "south-africa": "ZA", spain: "ES",
  sweden: "SE", switzerland: "CH", thailand: "TH", tunisia: "TN", turkey: "TR", "türkiye": "TR", ukraine: "UA", "united-arab-emirates": "AE",
  uruguay: "UY", usa: "US", "united-states": "US", uzbekistan: "UZ", venezuela: "VE", vietnam: "VN", wales: "GB-WLS", scotland: "GB-SCT",
  england: "GB-ENG", "northern-ireland": "GB-NIR",
};

/** Albanian names for the countries above, so they don't depend on the browser knowing Albanian. */
const SQ_NAMES: Record<string, string> = {
  AL: "Shqipëri",
  DZ: "Algjeri",
  AD: "Andorrë",
  AR: "Argjentinë",
  AM: "Armeni",
  AU: "Australi",
  AT: "Austri",
  AZ: "Azerbajxhan",
  BY: "Bjellorusi",
  BE: "Belgjikë",
  BO: "Bolivi",
  BA: "Bosnjë-Hercegovinë",
  BR: "Brazil",
  BG: "Bullgari",
  CA: "Kanada",
  CL: "Kili",
  CN: "Kinë",
  CO: "Kolumbi",
  CR: "Kosta-Rikë",
  HR: "Kroaci",
  CY: "Qipro",
  CZ: "Çeki",
  DK: "Danimarkë",
  EC: "Ekuador",
  EG: "Egjipt",
  EE: "Estoni",
  FO: "Ishujt Faroe",
  FI: "Finlandë",
  FR: "Francë",
  GE: "Gjeorgji",
  DE: "Gjermani",
  GH: "Ganë",
  GR: "Greqi",
  HU: "Hungari",
  IS: "Islandë",
  IN: "Indi",
  ID: "Indonezi",
  IR: "Iran",
  IQ: "Irak",
  IE: "Irlandë",
  IL: "Izrael",
  IT: "Itali",
  JP: "Japoni",
  JO: "Jordani",
  KZ: "Kazakistan",
  KR: "Kore e Jugut",
  LV: "Letoni",
  LT: "Lituani",
  LU: "Luksemburg",
  MT: "Maltë",
  MX: "Meksikë",
  MD: "Moldavi",
  ME: "Mal i Zi",
  MA: "Marok",
  NL: "Holandë",
  NZ: "Zelandë e Re",
  NG: "Nigeri",
  MK: "Maqedoni e Veriut",
  NO: "Norvegji",
  PY: "Paraguai",
  PE: "Peru",
  PL: "Poloni",
  PT: "Portugali",
  QA: "Katar",
  RO: "Rumani",
  RU: "Rusi",
  SM: "San Marino",
  SA: "Arabi Saudite",
  SN: "Senegal",
  RS: "Serbi",
  SG: "Singapor",
  SK: "Sllovaki",
  SI: "Slloveni",
  ZA: "Afrikë e Jugut",
  ES: "Spanjë",
  SE: "Suedi",
  CH: "Zvicër",
  TH: "Tajlandë",
  TN: "Tunizi",
  TR: "Turqi",
  UA: "Ukrainë",
  AE: "Emiratet e Bashkuara Arabe",
  UY: "Uruguai",
  US: "SHBA",
  UZ: "Uzbekistan",
  VE: "Venezuelë",
  VN: "Vietnam",
};

/** The UK's home nations: no ISO region name, so named here. */
const HOME_NATIONS: Record<string, { sq: string; en: string; emoji: string }> = {
  "GB-ENG": { sq: "Angli", en: "England", emoji: "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}" },
  "GB-SCT": { sq: "Skoci", en: "Scotland", emoji: "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}" },
  "GB-WLS": { sq: "Uells", en: "Wales", emoji: "\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}" },
  "GB-NIR": { sq: "Irlanda e Veriut", en: "Northern Ireland", emoji: "\u{1F1EC}\u{1F1E7}" },
};

/** Shown first, in this order: the countries most Players look for. */
const FIRST = ["albania", "world", "england", "spain", "italy", "germany", "france", "kosovo", "portugal", "netherlands", "turkey", "greece"];

const keyOf = (country: string) => country.trim().toLowerCase().replace(/\s+/g, "-");

export const isInternational = (country: string) => keyOf(country) === "world";

function isoOf(country: string, flag: string | null | undefined): string | null {
  const known = ISO[keyOf(country)];
  if (known) return known;
  // The feed's flag address carries the code: …/flags/gb-eng.svg, …/flags/al.svg.
  const fromFlag = /\/flags\/([a-z]{2}(?:-[a-z]{3})?)\.svg$/i.exec(flag ?? "")?.[1];
  return fromFlag ? fromFlag.toUpperCase() : null;
}

const regionNames = new Map<string, Intl.DisplayNames | null>();
function regions(lang: string): Intl.DisplayNames | null {
  if (!regionNames.has(lang)) {
    try {
      regionNames.set(lang, new Intl.DisplayNames([lang], { type: "region" }));
    } catch {
      regionNames.set(lang, null);
    }
  }
  return regionNames.get(lang) ?? null;
}

/** The country's name in the reader's language; the feed's English name when it isn't known. */
export function countryLabel(country: string, flag: string | null | undefined, lang: "sq" | "en", international: string): string {
  if (isInternational(country)) return international;
  const iso = isoOf(country, flag);
  if (!iso) return country;
  if (HOME_NATIONS[iso]) return HOME_NATIONS[iso][lang];
  if (iso === "XK") return lang === "sq" ? "Kosovë" : "Kosovo";
  if (lang === "sq" && SQ_NAMES[iso]) return SQ_NAMES[iso];
  const name = regions(lang)?.of(iso);
  return name && name !== iso ? name : country;
}

/** A flag to show when the feed sent no picture: the emoji flag, or a globe for International. */
export function countryEmoji(country: string, flag: string | null | undefined): string {
  if (isInternational(country)) return "\u{1F30D}";
  const iso = isoOf(country, flag);
  if (!iso) return "\u{1F3F3}";
  if (HOME_NATIONS[iso]) return HOME_NATIONS[iso].emoji;
  if (!/^[A-Z]{2}$/.test(iso)) return "\u{1F3F3}";
  return String.fromCodePoint(0x1f1e6 + iso.charCodeAt(0) - 65, 0x1f1e6 + iso.charCodeAt(1) - 65);
}

/** Sort position: the main countries first in a fixed order, then the rest by name. */
export function countryRank(country: string): number {
  const at = FIRST.indexOf(keyOf(country));
  return at === -1 ? FIRST.length : at;
}
