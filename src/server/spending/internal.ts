import { accountsMissingCashRecord } from "../../core/ledger.ts";
import { EUR } from "../../core/money.ts";
import type { Txn } from "../../core/types.ts";

const WINDOW_DAYS = 5;

const dayNumber = (date: string): number => Date.parse(`${date}T00:00:00Z`) / 86_400_000;

/**
 * The owner's own transfers between their accounts, matched as pairs: one row out and one in,
 * same amount, within days, nearest first, each row used once. Text cannot do it (the owner's own
 * name would also catch payments to a namesake, and an assistant rule once turned savings into
 * income). A transfer whose other half is on an unknown account stays income or spending.
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
 * Bank payments that funded a purchase (investing, not spending). A fund saving leaves as a
 * payment and arrives as a purchase, never a deposit, so both halves are negative and the pairing
 * above cannot see it. Matched on amount and window against purchases on accounts with no cash record.
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

// Accounts whose export never records cash arriving (OP's securities view): purchases stand in for the deposits.
export const cashlessAccountIds = (
  txns: readonly Txn[],
  bankAccountIds: ReadonlySet<number>,
): ReadonlySet<number> =>
  new Set(accountsMissingCashRecord(txns).filter((accountId) => !bankAccountIds.has(accountId)));

/** Every row that is a movement rather than a cost. One definition, as views disagreed; needs the whole ledger since a transfer is recognised by its other half. */
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
