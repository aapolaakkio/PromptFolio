import { EUR } from "../../core/money.ts";
import { eur } from "../lib/format.ts";

/** Today's holdings and money paid in after today, never one sum: the second is spread over the years. */
export const paidInText = (startValueEur: number, newMoneyEur: number): string =>
  `of which today's holdings ${eur(String(startValueEur))} and new money ${eur(String(newMoneyEur))}`;

/** Null when every holding is in euros. */
export const currencyNote = (
  holdings: readonly { readonly name: string; readonly currency: string }[],
): string | null => {
  const foreign = holdings.filter((row) => row.currency !== EUR);
  return foreign.length === 0
    ? null
    : "Growth is measured in each instrument's own currency; exchange-rate moves are not included (" +
        foreign.map((row) => `${row.name} in ${row.currency}`).join(", ") +
        ").";
};
