import * as parts from "./sq/index";

/** English → Albanian. Split by area in ./sq/; see core.ts for how it's used. */
export const sq: Record<string, string> = Object.assign({}, ...Object.values(parts));
