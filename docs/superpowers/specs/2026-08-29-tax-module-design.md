# PromptFolio — Phase 4: Finnish tax module

Status: Approved (design). Implements phase 4 of the
[portfolio manager design](2026-08-27-portfolio-manager-design.md), whose §11 deferred the exact
Finnish rules to this document, to be "verified against vero.fi at that time rather than assumed".
§3 below is that verification.

## 1. Purpose

Finnish brokers report securities trades and dividends to Verohallinto, so the tax return arrives
pre-filled. This module does not file anything. It computes the same figures independently from the
ledger, so the pre-filled return can be checked against a second, visible derivation — and so the
gaps a broker cannot fill (an account it does not hold, a corporate action it booked differently)
become visible instead of being taken on trust.

The output is therefore a **verification report**, per tax year: taxable income figures with their
workings, not a filing and not a bill.

## 2. Scope

**In scope.** Realised gains and losses on disposals in an ordinary book-entry account (AOT);
dividends; withdrawals from an equity savings account (OST); the small-sales exemption; loss
carry-forward; the OST lifetime deposit cap.

**Deliberately out of scope,** each because the app cannot be right about it:

- **Euros of tax owed.** The 30 %/34 % bracket depends on the owner's *total* capital income,
  including income this app cannot see — rental income, accounts elsewhere, a spouse's figures. A
  bracket applied to a partial total is the same class of confident-wrong number the amendment
  series in the phase 1 spec exists to record. The 30/34 % rates therefore appear nowhere in the
  code, not even as unused constants.
- **Foreign dividend tax credit.** Treaty-dependent and per-country. The report shows the gross
  dividend and the tax withheld and stops there.
- **Unlisted-company dividends.** A different regime (the 8 %-of-net-worth split). Not held.
- **Filing or file export.** No OmaVero upload format, no field mapping.

## 3. The rules, verified

Verified against vero.fi on 2026-08-29. Every figure the code needs is a constant in
`core/tax/rates.ts` carrying its citation as a comment — a tax rule changes without warning, and a
constant whose provenance is not written down cannot be re-checked. Two rows are recorded for the
reader rather than used: the 25.5 % withheld at source (the ledger stores what was *actually*
withheld, per payment, in `transactions.tax`), and the rules expressed as behaviour rather than a
number.

| Rule | Value | Source |
| --- | --- | --- |
| Deemed acquisition cost, held < 10 years | 20 % of the sale price | [Selling shares](https://www.vero.fi/en/individuals/property/investments/selling-shares/) |
| Deemed acquisition cost, held ≥ 10 years | 40 % of the sale price | as above |
| Small-sales exemption | total annual sale prices ≤ 1 000 € → gains exempt | as above |
| Loss carry-forward | 5 following years | as above |
| Lot matching | FIFO, **within one account** | as above |
| Listed dividend, taxable share | 85 % taxable, 15 % exempt | [Dividends from a listed company](https://www.vero.fi/en/individuals/property/investments/dividends/dividends-from-a-listed-company/) |
| Withheld at source by the payer | 25.5 % | as above |
| OST lifetime deposit cap | 100 000 € | [Equity savings account](https://www.vero.fi/en/individuals/property/investments/equity-savings-account/) |
| OST: trades and dividends inside the account | not taxed | as above |
| OST withdrawal | (profit ÷ fair market value) × amount withdrawn | as above |
| OST: deemed acquisition cost | does not apply | as above |
| OST loss | deductible only in the year the account is closed | as above |

**Correction to the phase 1 spec.** §10c C7 records the OST cap as "50 000 € at the time of
writing". It is 100 000 €. C7's substantive point — that an OST is not a variation on an ordinary
account and cannot be taxed like one — stands unchanged.

**§11 resolved.** Phase 1's open question ("FIFO vs. hankintameno-olettama, the 30 %/34 % bracket
boundary, 85 %-taxable listed dividends") is answered by this table, except the bracket, which is
now out of scope rather than unresolved.

## 4. What the report contains

Per tax year:

1. **Disposals (AOT).** Per sale: date, instrument, proceeds, FIFO cost, gain or loss — and the
   same gain computed under the deemed acquisition cost, with the more favourable method marked.
   The taxpayer may take whichever is better, so showing only one is showing the wrong one half the
   time.
2. **Small-sales exemption.** The year's total sale prices, and whether the year falls under the
   1 000 € threshold.
3. **Losses.** The year's net loss and what carries forward, by year of origin.
4. **Dividends.** Per payment: gross, tax withheld, the taxable 85 %.
5. **OST withdrawals.** Per withdrawal: amount, the account's value and profit at that date, the
   taxable share — or, where the account cannot be valued, the blocker (§7).
6. **OST deposits.** Lifetime deposits against the 100 000 € cap.

## 5. Module boundaries

New, pure, no I/O, under `src/core/tax/`:

| File | Responsibility |
| --- | --- |
| `rates.ts` | The constants of §3, each with its citation |
| `disposals.ts` | Lots → taxable disposals, both methods, with the exclusions of §6 |
| `dividends.ts` | Gross, withheld, taxable share |
| `ost.ts` | Withdrawal apportionment against an injected account-value lookup |
| `year.ts` | Assembles one tax year: exemption, netting, carry-forward |

`src/server/tax.ts` translates stored integers into the view types (decimal strings on the wire,
per §4.1 of the phase 1 spec); `src/server/api/tax.ts` serves `GET /api/tax?year=YYYY` and
`GET /api/tax/years`. `src/web/routes/tax.tsx` is the **Verot** tab. A `get_tax_year` chat tool
reads through `server/tax.ts`, so the assistant and the screen cannot disagree — the same rule §10d
D2 already applies to every other tool.

Figures are **derived, not stored** — the choice §10e E2 made for cash. The consequence is that
importing an old page changes a past year, so the report states what it was computed from (§7).
Freezing a filed year in a `tax_reports` table is a defensible alternative and is not built:
nothing yet depends on a figure being immutable after the fact.

## 6. Computation

### 6.1 FIFO is per account

`core/costbasis.ts`'s `buildLots` keys lots by `instrumentId` alone; `accountId` appears nowhere in
the file. Lots are therefore pooled across accounts, and FIFO across a pool is not the FIFO the
rule names. No instrument is currently held in two brokerage accounts, so the answer is at present
accidentally correct — but this is precisely the defect C7 predicted, and the tax module is where
it starts to matter.

`buildLots` will key lots by `(accountId, instrumentId)`. `costBasisPerInstrument` must keep
aggregating across accounts so `holdingsFor` is unchanged: the holdings view is about a position,
which spans accounts; tax is about an account.

### 6.2 Three exclusions

- **OST disposals and OST dividends are not taxable events.** They must not appear in sections 1
  or 4. Tax inside an OST falls on withdrawal, and counting a sale there as well would tax the same
  money twice.
- **Transfers are not disposals.** `buildLots` treats `TRANSFER_OUT` as a disposal, correctly, for
  cost-basis purposes. Moving one's own shares is not a sale, and a taxable disposal set that
  includes transfers reports gains that were never realised.
- **An OST loss is not deductible** except in the year the account is closed.

### 6.3 Gross versus net proceeds

A `SELL`'s `amount` is net of the fee (see `Txn.amount`'s doc). The two methods need different
bases, and using one for both quietly favours the wrong method:

- **Actual cost:** the selling fee is deductible, so `amount` — net — is the right base.
- **Deemed cost:** the deemed cost is a percentage of the *sale price*, with fees not separately
  deductible on top, so the base is `amount + fee` — gross.

### 6.4 The exemption cuts both ways

Under the 1 000 € threshold the year's gains are exempt — and its losses are correspondingly not
deductible. Reporting the exemption without that overstates the carry-forward.

### 6.5 Ownership duration

The 10-year boundary is calendar-based, measured from each lot's `acquiredOn` to the disposal date,
which is why the disposal must carry the lot's acquisition date rather than an average.

### 6.6 Arithmetic

Integer minor units throughout, per §4.1. A deemed cost is a percentage of a `Money`, computed as
an exact integer ratio and rounded half-up to the cent — never through a float.

## 7. When a figure cannot be computed

The rule this codebase already follows: name the gap, never fabricate the number.

- **An OST withdrawal whose account cannot be valued.** The OST rule needs the account's fair
  market value on the withdrawal date. A holding that is unlisted, or delisted with no surviving
  price feed, has no market price, and in the real ledger this blocks most historical withdrawal
  dates. The row reports the withdrawal and names the instrument and date that block it. The remedy
  already exists: recording a manual price for that date makes the row compute.
- **A disposal with no matching purchase.** Reuses `costBasisError`: that instrument's gain reads
  *tuntematon* and the rest of the year still computes. One un-imported page must not blank a year.
- **An incomplete ledger.** No internal check can detect a missing purchase that was never
  imported, so the report states what it was computed from and the ledger's earliest transaction
  date, and leaves the judgement to the reader.

## 8. Testing

Per the phase 1 spec §9.4 and the 80 % per-file floor:

- vero.fi's own worked OST example — 15 000 € value, 5 000 € profit, 1 500 € withdrawn, 500 €
  taxable — as a fixture, so the apportionment is checked against the authority's arithmetic.
- Boundaries: exactly 10 years' ownership; sale prices totalling exactly 1 000 €.
- A disposal where the deemed cost beats the actual cost, and one where it does not.
- OST disposals and transfers proven absent from the taxable set.
- Losses carried into the fifth year and dropped in the sixth.
- Per-account FIFO: the same instrument in two accounts, disposed from one, does not consume the
  other's lots — and `holdingsFor` returns what it returned before the change.
- No test touches the network (§9.4); the rules are constants, not fetched.

## 9. Not built

- **Freezing a filed year.** §5.
- **Tax owed, foreign tax credit, unlisted dividends, filing export.** §2.
- **Debt as an account** and **income beyond the bank** remain open from §10f F8, untouched here.
