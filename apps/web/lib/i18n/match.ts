// No imports, so scripts/i18n-check.mjs can load this file as it is.

type Pattern = { regex: RegExp; names: string[]; target: string; loose: boolean };

/**
 * Patterns with this little fixed text ("{home} or {away}", "{from} to {to}")
 * are meant for team, market and pick names. Without a check they would also
 * match an English sentence the dictionary doesn't know and translate one word
 * in the middle of it ("longer than ose equal deri 3 characters").
 */
const LOOSE = 6;

/** Words that turn up in English sentences but not in team, market or pick names. */
const SENTENCE_WORD = /(?:^|\s)(?:is|are|was|were|be|been|not|must|should|can|cannot|could|will|would|has|have|had|the|than|you|your|this|that|it|its)(?=\s|$)/;

function compile(dict: Record<string, string>): Pattern[] {
  return Object.entries(dict)
    .filter(([key]) => /\{\w+\}/.test(key))
    .map(([key, target]) => {
      const names: string[] = [];
      const source = key
        .split(/(\{\w+\})/)
        .map((part) => {
          const name = /^\{(\w+)\}$/.exec(part)?.[1];
          if (name) {
            names.push(name);
            return "(.+?)";
          }
          return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("");
      // The more fixed text a pattern has, the more specific it is, so it's tried first.
      const literal = key.replace(/\{\w+\}/g, "").length;
      return { regex: new RegExp(`^${source}$`, "s"), names, target, loose: literal <= LOOSE, literal };
    })
    .sort((a, b) => b.literal - a.literal)
    .map(({ regex, names, target, loose }) => ({ regex, names, target, loose }));
}

function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? vars[name] : match));
}

/**
 * Translates text the API sends, using a dictionary whose `{placeholder}`
 * keys work as patterns; what a pattern captures is translated too.
 */
export function createServerTranslator(dict: Record<string, string>): (text: string) => string {
  let patterns: Pattern[] | null = null;
  const cache = new Map<string, string>();

  function run(text: string, depth: number): string {
    const exact = dict[text];
    if (exact !== undefined) return exact;
    if (depth >= 4) return text;
    patterns ??= compile(dict);
    for (const pattern of patterns) {
      const match = pattern.regex.exec(text);
      if (!match) continue;
      const vars: Record<string, string> = {};
      let fits = true;
      pattern.names.forEach((name, index) => {
        const part = match[index + 1];
        const translated = run(part, depth + 1);
        if (pattern.loose && translated === part && SENTENCE_WORD.test(part)) fits = false;
        vars[name] = translated;
      });
      if (fits) return fill(pattern.target, vars);
    }
    return text;
  }

  return (text) => {
    const cached = cache.get(text);
    if (cached !== undefined) return cached;
    const result = run(text, 0);
    if (cache.size > 5000) cache.clear();
    cache.set(text, result);
    return result;
  };
}
