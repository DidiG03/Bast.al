const moneyFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** The currency every amount is shown in: Albanian lek. */
export const CURRENCY = "ALL";

/**
 * "12,000.00 ALL" — thousands separators keep large balances readable on
 * narrow screens. Below zero it reads "-200.00 ALL" (a balance can go below
 * zero when a corrected result takes winnings back).
 */
export function formatMoney(value: number | string): string {
  const amount = Number.isFinite(Number(value)) ? Number(value) : 0;
  return amount < 0 ? `-${moneyFormat.format(-amount)} ${CURRENCY}` : `${moneyFormat.format(amount)} ${CURRENCY}`;
}

/** Same as formatMoney: for amounts that are expected to go either way. */
export function formatSignedMoney(value: number | string): string {
  return formatMoney(value);
}

/** A stake as the bet buttons show it: "2,500 ALL", without cents when there are none ("12.50 ALL" keeps them). */
export function formatStake(value: number | string): string {
  return formatMoney(value).replace(/\.00(?= )/, "");
}
