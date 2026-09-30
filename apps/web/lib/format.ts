const moneyFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * "$12,000.00" — thousands separators keep large balances readable on narrow
 * screens. Below zero it reads "-$200.00" (a balance can go below zero when a
 * corrected result takes winnings back).
 */
export function formatMoney(value: number | string): string {
  const amount = Number.isFinite(Number(value)) ? Number(value) : 0;
  return amount < 0 ? `-$${moneyFormat.format(-amount)}` : `$${moneyFormat.format(amount)}`;
}

/** Same as formatMoney: for amounts that are expected to go either way. */
export function formatSignedMoney(value: number | string): string {
  return formatMoney(value);
}
