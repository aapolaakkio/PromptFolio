import { accountsMissingCashRecord } from "../../core/ledger.ts";
import { EUR } from "../../core/money.ts";
import type { Txn } from "../../core/types.ts";

/** How far apart the two halves of one transfer may be booked. */
const WINDOW_DAYS = 5;

const dayNumber = (date: string): number => Date.parse(`${date}T00:00:00Z`) / 86_400_000;

/**
 * The owner moving their own money between their own accounts, matched as pairs.
 *
 * Text cannot do this: a transfer to savings is labelled with the owner's own
 * name, and a rule matching that would catch genuine payments to a person of
 * that name -- and the assistant's classification can out-match a transfer rule
 * and turn moved savings into income, which it did.
 *
 * A pair is one row out and one in, same amount, within days, matched nearest
 * first and each row used once. Conservative: a transfer whose other half is on
 * an account this app does not know stays income or spending, because from the
 * ledger's point of view that is what it is.
 */
export const internalTransferIds = (txns: readonly Txn[]): ReadonlySet<number> => {
  const paired = new Set<number>();
  const outgoing = txns
    .filter((txn) => txn.amount.minor < 0n && txn.currency === EUR)
    .sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : 1));
  const incoming = txns
    .filter((txn) => txn.amount.minor > 0n && txn.currency === EUR)
    .sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : 1));

  for (const out of outgoing) {
    const wanted = -out.amount.minor;
    const day = dayNumber(out.tradeDate);

    const match = incoming
      .filter(
        (candidate) =>
          !paired.has(candidate.id) &&
          candidate.accountId !== out.accountId &&
          candidate.amount.minor === wanted &&
          Math.abs(dayNumber(candidate.tradeDate) - day) <= WINDOW_DAYS,
      )
      .sort(
        (a, b) => Math.abs(dayNumber(a.tradeDate) - day) - Math.abs(dayNumber(b.tradeDate) - day),
      )[0];

    if (match) {
      paired.add(out.id);
      paired.add(match.id);
    }
  }

  return paired;
};

/**
 * Bank payments that funded a purchase, and so are investing, not spending.
 *
 * A fund saving leaves as an ordinary payment and arrives as a purchase, never
 * as a deposit, because a broker listing securities only never records the cash.
 * Both halves are negative, so the pairing above cannot see them.
 *
 * Matched on amount and window, against purchases on accounts keeping no cash
 * record. Where a broker does keep one, its deposit is the better half.
 */
export const investmentPaymentIds = (
  txns: readonly Txn[],
  cashlessInvestedAccountIds: ReadonlySet<number>,
  bankAccountIds: ReadonlySet<number>,
): ReadonlySet<number> => {
  const purchases = txns.filter(
    (txn) =>
      txn.type === "BUY" && txn.currency === EUR && cashlessInvestedAccountIds.has(txn.accountId),
  );
  if (purchases.length === 0) return new Set();

  const used = new Set<number>();
  const matched = new Set<number>();

  for (const payment of txns) {
    if (!bankAccountIds.has(payment.accountId)) continue;
    if (payment.amount.minor >= 0n || payment.currency !== EUR) continue;
    const day = dayNumber(payment.tradeDate);

    const purchase = purchases.find(
      (candidate) =>
        !used.has(candidate.id) &&
        candidate.amount.minor === payment.amount.minor &&
        Math.abs(dayNumber(candidate.tradeDate) - day) <= WINDOW_DAYS,
    );
    if (purchase) {
      used.add(purchase.id);
      matched.add(payment.id);
    }
  }

  return matched;
};

/**
 * Invested accounts whose own export never records cash arriving -- OP's
 * securities view is one. Their purchases stand in for the deposits that fund
 * them, which is how a regular fund saving is recognised as investing rather
 * than spending.
 */
export const cashlessAccountIds = (
  txns: readonly Txn[],
  bankAccountIds: ReadonlySet<number>,
): ReadonlySet<number> =>
  new Set(accountsMissingCashRecord(txns).filter((accountId) => !bankAccountIds.has(accountId)));

/**
 * Every row that is a movement rather than a cost.
 *
 * One definition, because there were several and they disagreed: the same period
 * read differently depending on which view you opened, and a credit card bill
 * sat among the shops as one of the year's largest lines.
 *
 * Needs the whole ledger: an internal transfer is only recognisable by its other
 * half, which is on another account.
 */
export const notSpendingIds = (
  txns: readonly Txn[],
  bankAccountIds: ReadonlySet<number>,
): ReadonlySet<number> => {
  const internal = internalTransferIds(txns);
  const invested = investmentPaymentIds(
    txns,
    cashlessAccountIds(txns, bankAccountIds),
    bankAccountIds,
  );
  return new Set([...internal, ...invested]);
};
