import { EUR } from "../../core/money";
import type { Txn } from "../../core/types";

/** How far apart the two halves of one transfer may be booked. */
const WINDOW_DAYS = 5;

const dayNumber = (date: string): number => Date.parse(`${date}T00:00:00Z`) / 86_400_000;

/**
 * Transactions that are the owner moving their own money between their own
 * accounts, matched as pairs rather than recognised by their text.
 *
 * Text cannot do this job. A transfer to a savings account is labelled with the
 * owner's own name, an account opening says "Tilinavaus", and a rule matching
 * either would also catch genuine payments to a person of that name. Worse, the
 * assistant's own classification can out-match a transfer rule and quietly turn
 * moved savings into income -- which is exactly what it did.
 *
 * A pair is one row out of one owned account and one row into another, for the
 * same amount, within a few days. Matched greedily, nearest first, and each row
 * used once: two identical transfers on the same day pair with each other,
 * which is the right answer whichever way round they are taken.
 *
 * Deliberately conservative. A transfer whose other half is not in the ledger --
 * to an account this app does not know -- stays income or spending, because
 * from the ledger's point of view that is what it is.
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
 * Bank payments that funded a securities purchase, and so are investing rather
 * than spending.
 *
 * A regular fund saving leaves the current account as an ordinary payment and
 * arrives at the broker as a BUY -- never as a deposit, because a broker whose
 * export lists securities only (OP's does) never records the cash arriving.
 * Both halves are therefore negative, so `internalTransferIds` cannot pair
 * them: it looks for opposite signs.
 *
 * Matched on the amount within the same window, against purchases on accounts
 * that keep no cash record of their own. Where a broker does record its cash,
 * the deposit is the better half to count and this does not apply.
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
