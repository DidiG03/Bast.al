const moneyFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "$12,000.00" — thousands separators keep large balances readable on narrow screens. */
export function formatMoney(value: number | string): string {
  const amount = Number(value);
  return `$${moneyFormat.format(Number.isFinite(amount) ? amount : 0)}`;
}

/** "-$12.00" rather than "$-12.00" for amounts that can go negative. */
export function formatSignedMoney(value: number | string): string {
  const amount = Number(value);
  return amount < 0 ? `-${formatMoney(-amount)}` : formatMoney(amount);
}
