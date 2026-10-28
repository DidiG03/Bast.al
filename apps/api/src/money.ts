/** An amount as the site shows it in messages: "100,000.00 ALL", thousands separated, always two decimals. */
export function formatAll(value: number | { toString(): string }): string {
  return `${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ALL`;
}
