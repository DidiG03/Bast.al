const moneyFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "$12,000.00" — thousands separators keep large balances readable on narrow screens. */
export function formatMoney(value: number | string): string {
  const amount = Number(value);
  return `$${moneyFormat.format(Number.isFinite(amount) ? amount : 0)}`;
}
