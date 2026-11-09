import { EUR, formatMoney, parseMoney } from "../../core/money.ts";

const decimal = (text: string): string => text.replace(",", ".").replace(/\s/g, "");

/** A printed total lets the rows be checked against it, like a bank statement's balances. Null when nothing was printed. */
export const holdingsTotalCheck = (
  rows: readonly { readonly marketValueEur: string }[],
  statedTotalEur: string | null,
): { ok: boolean; differenceEur: string } | null => {
  if (statedTotalEur === null) return null;
  const sum = rows.reduce(
    (total, row) => total + parseMoney(decimal(row.marketValueEur), EUR).minor,
    0n,
  );
  const stated = parseMoney(decimal(statedTotalEur), EUR).minor;
  const difference = stated - sum;
  return {
    ok: difference === 0n,
    differenceEur: formatMoney({ minor: difference, currency: EUR }),
  };
};
