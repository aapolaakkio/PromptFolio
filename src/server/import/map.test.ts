import { readBytes, readText } from "../files.ts";
import { test, expect } from "vitest";
import { mapRows, normaliseDate, contentHash, type DraftTxn } from "./map.ts";
import { parseCsv } from "./csv.ts";
import { runBrokerRecord } from "./recipe/broker-record.ts";
import { OP_PASTE_RECIPE } from "./recipe/broker-reference.ts";
import { NORDNET, OP_WEB_PASTE } from "./fixtures/broker-mappings.ts";
import { buildLots } from "../../core/costbasis.ts";
import { EUR, parseCurrency, formatMoney, money, parseFxRate } from "../../core/money.ts";
import type { RawRow } from "./types.ts";
import type { TransactionType, Txn } from "../../core/types.ts";

const fixture = (name: string) => readBytes(`${import.meta.dirname}/fixtures/${name}`);
const opFixture = (name: string) => readText(`${import.meta.dirname}/fixtures/${name}`);

/** An OP paste, read by its reference recipe into the draft `mapRows` builds. */
const opDraft = (text: string, options: { knownNames?: Map<string, number> } = {}) =>
  runBrokerRecord(
    text,
    OP_PASTE_RECIPE,
    { knownIsins: new Map(), knownNames: options.knownNames ?? new Map() },
    0,
  ).draft;

/** UTF-16LE-with-BOM, tab-delimited bytes, matching NORDNET's real encoding. */
const nordnetBytes = (text: string): ArrayBuffer => {
  const withBom = `﻿${text}`;
  const bytes = new Uint8Array(withBom.length * 2);
  for (let i = 0; i < withBom.length; i++) {
    const code = withBom.charCodeAt(i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = (code >> 8) & 0xff;
  }
  return bytes.buffer;
};

const NORDNET_HEADER = [
  "Id",
  "Kirjauspäivä",
  "Kauppapäivä",
  "Maksupäivä",
  "Salkku",
  "Tapahtumatyyppi",
  "Arvopaperi",
  "ISIN",
  "Määrä",
  "Kurssi",
  "Korko",
  "Kokonaiskulut",
  "Valuutta",
  "Summa",
  "Valuutta",
  "Hankinta-arvo",
  "Valuutta",
  "Tulos",
  "Valuutta",
  "Kokonaismäärä",
  "Saldo",
  "Vaihtokurssi",
  "Tapahtumateksti",
  "Mitätöintipäivä",
  "Laskelma",
  "Vahvistusnumero",
  "Välityspalkkio",
  "Valuutta",
  "Viitevaluuttakurssi",
  "Alkuperäinen korko",
].join("\t");

/** Builds one 30-column Nordnet row, blank everywhere not given. */
const nordnetRow = (o: {
  id: string;
  date: string;
  type: string;
  name?: string;
  isin?: string;
  qty?: string;
  price?: string;
  fee?: string;
  currency?: string;
  amount: string;
  /** `Tapahtumateksti`, the broker's own words for the row. */
  text?: string;
  /** The `Valuutta` after `Summa` -- what the cash settled in. */
  settled?: string;
  /** The `Valuutta` after `Tulos` -- what the trade was priced in. */
  priceCurrency?: string;
}): string => {
  const c = Array.from({ length: 30 }, () => "");
  c[0] = o.id;
  c[1] = o.date;
  c[2] = o.date;
  c[3] = o.date;
  c[4] = "11223344";
  c[5] = o.type;
  c[6] = o.name ?? "";
  c[7] = o.isin ?? "";
  c[8] = o.qty ?? "";
  c[9] = o.price ?? "";
  c[10] = "0";
  c[11] = o.fee ?? "";
  c[12] = o.currency ?? "";
  c[13] = o.amount;
  c[14] = o.settled ?? "EUR";
  c[18] = o.priceCurrency ?? "";
  c[22] = o.text ?? "";
  return c.join("\t");
};

/** `NORDNET_HEADER`'s real 1-based column position (0-indexed here) for each field name used below. */
const REAL_INDEX = {
  Id: 0,
  Kauppapäivä: 2,
  Tapahtumatyyppi: 5,
  Arvopaperi: 6,
  ISIN: 7,
  Määrä: 8,
  Kurssi: 9,
  Kokonaiskulut: 11,
  // The `Valuutta` that follows `Summa`: the currency the cash settled in, and
  // the one the config reads as the transaction's own. The blank one at index
  // 12 qualifies `Kokonaiskulut`.
  Valuutta: 14,
  Summa: 13,
} satisfies Record<string, number>;

/**
 * Builds a hand-rolled `RawRow` for a test that only cares about a handful
 * of fields (type/amount/currency validation, unrelated to the duplicate-
 * `Valuutta` fix itself). `cells` is populated at each field's real column
 * index, so the row can be fed straight to the real `NORDNET` config --
 * these tests predate `columnPositions` but must still exercise the config
 * that actually ships, not a stand-in with `currency` addressed by name.
 */
const rawRow = (line: number, values: Record<string, string>): RawRow => {
  const cells = Array.from({ length: 30 }, () => "");
  for (const [key, index] of Object.entries(REAL_INDEX)) {
    const value = values[key];
    if (value !== undefined) cells[index] = value;
  }
  return { line, values, cells };
};

test("normalises both date formats to ISO", async () => {
  expect(normaliseDate("2025-01-10", "iso")).toBe("2025-01-10");
  expect(normaliseDate("15.01.2025", "fi")).toBe("2025-01-15");
  expect(() => normaliseDate("32.01.2025", "fi")).toThrow();
  expect(() => normaliseDate("", "iso")).toThrow();
});

test("maps the real-format Nordnet fixture into draft transactions", async () => {
  const { rows } = parseCsv(await fixture("nordnet-sample.csv"), NORDNET);
  const known = new Map([["IE0002Y8CX98", 7]]);
  const draft = mapRows(rows, NORDNET, known);

  // One of the fixture's 13 rows is reported rather than booked: the
  // fractional adjustment's cash-only twin, whose quantity and cash the other
  // leg already carries -- see fixtures/broker-mappings.ts's ignoredTypes.
  expect(draft.problems).toHaveLength(1);
  expect(draft.txns).toHaveLength(12);

  const buy = draft.txns[0]!;
  expect(buy.type).toBe("BUY");
  expect(buy.tradeDate).toBe("2025-01-10");
  expect(buy.instrumentId).toBe(7);
  expect(buy.quantity).toBe(2_000_000); // 2 units, scaled 1e6
  expect(buy.unitPrice).toBe(3400); // 34,00 EUR
  expect(buy.amount).toBe(-6800);
  expect(buy.currency).toBe(EUR);
});

test("a deposit has no instrument and no quantity", async () => {
  const { rows } = parseCsv(await fixture("nordnet-sample.csv"), NORDNET);
  const draft = mapRows(rows, NORDNET, new Map());
  const deposit = draft.txns.find((t) => t.type === "DEPOSIT" && t.amount === 50000)!;
  expect(deposit.instrumentId).toBeNull();
  expect(deposit.quantity).toBe(0);
});

test("Reaaliaikainen talle and TALLETUS both map to DEPOSIT", async () => {
  const { rows } = parseCsv(await fixture("nordnet-sample.csv"), NORDNET);
  const draft = mapRows(rows, NORDNET, new Map());
  const deposits = draft.txns.filter((t) => t.type === "DEPOSIT");
  expect(deposits).toHaveLength(2);
});

test("the ETF service fee and its reversal (Nordnet's own typo) both map to FEE", async () => {
  const { rows } = parseCsv(await fixture("nordnet-sample.csv"), NORDNET);
  const draft = mapRows(rows, NORDNET, new Map());
  const fees = draft.txns.filter((t) => t.type === "FEE");
  expect(fees).toHaveLength(2);
  expect(fees.some((t) => t.amount < 0)).toBe(true); // the charge
  expect(fees.some((t) => t.amount > 0)).toBe(true); // "PER ETF-KK SÄÄSTÖN PALVEMAKSU", the reversal
});

test("PÄÄOMIT YLIT.KORKO and LAINAKORKO both map to INTEREST", async () => {
  const { rows } = parseCsv(await fixture("nordnet-sample.csv"), NORDNET);
  const draft = mapRows(rows, NORDNET, new Map());
  expect(draft.txns.filter((t) => t.type === "INTEREST")).toHaveLength(2);
});

test("the VAIHTO pair is booked as a transfer pair, with the acquisition value carried across", async () => {
  const { rows } = parseCsv(await fixture("nordnet-sample.csv"), NORDNET);
  const draft = mapRows(rows, NORDNET, new Map());
  expect(draft.txns.some((t) => t.type === "TRANSFER_OUT")).toBe(true);
  expect(draft.txns.some((t) => t.type === "TRANSFER_IN")).toBe(true);
  // An acquisition's amount must never be positive -- costbasis.ts throws on
  // one -- and a zero would price the merged-in holding at no cost at all.
  const transferIn = draft.txns.find((t) => t.type === "TRANSFER_IN")!;
  expect(transferIn.amount).toBeLessThan(0);
});

test("the DESIM pair books one disposal and reports its cash-only twin as skipped", async () => {
  const { rows } = parseCsv(await fixture("nordnet-sample.csv"), NORDNET);
  const draft = mapRows(rows, NORDNET, new Map());
  expect(draft.problems.some((p) => p.raw["Tapahtumatyyppi"] === "DESIM. ULOSKIRJ. KÄT")).toBe(
    true,
  );
  expect(draft.problems.every((p) => p.message.includes("Tuntematon tapahtumatyyppi"))).toBe(false);
  expect(draft.txns.some((t) => t.externalId === "5010")).toBe(true);
});

test("collects ISINs it has never seen instead of inventing instruments", async () => {
  const { rows } = parseCsv(await fixture("nordnet-sample.csv"), NORDNET);
  const draft = mapRows(rows, NORDNET, new Map([["IE0002Y8CX98", 7]]));
  // Every mapped row's ISIN reaches unknown-instrument tracking, including the
  // swap and fractional-adjustment rows now that those are booked rather than
  // refused at the typeMap lookup.
  const isins = draft.unknownIsins.map((u) => u.isin);
  expect(isins).toContain("SE0005993102");
  expect(draft.txns.find((t) => t.isin === "SE0005993102")!.instrumentId).toBeNull();
});

// --- OP web-paste, read by its reference recipe --

test("maps the OP fixture's OSTO-with-fee row: fi dates, unit suffixes, and a name-only instrument", async () => {
  const draft = opDraft(await opFixture("op-web-paste-sample.txt"));
  expect(draft.problems).toEqual([]);
  expect(draft.txns).toHaveLength(4);

  const buy = draft.txns[0]!;
  expect(buy.type).toBe("BUY");
  expect(buy.tradeDate).toBe("2025-08-10"); // dd.mm.yyyy -> ISO
  expect(buy.quantity).toBe(1_200_000); // "1,2000   kpl" -> 1.2, scaled 1e6
  expect(buy.unitPrice).toBe(25000); // "250,00   EUR" -> 250.00
  expect(buy.fee).toBe(2); // "0,02   EUR" -> 0.02
  expect(buy.amount).toBe(-30002); // unsigned "300,02   EUR", signed negative by OSTO
  expect(buy.isin).toBeNull(); // OP's web view has no ISIN column at all
});

test("the OP fixture's OSTO-without-fee row (the fee line is absent, not blank) still parses", async () => {
  const draft = opDraft(await opFixture("op-web-paste-sample.txt"));
  const noFee = draft.txns[1]!;
  expect(noFee.fee).toBe(0);
  expect(noFee.amount).toBe(-30000);
});

test("the OP fixture's MYYNTI row: unsigned total re-signed positive, never cross-checked against quantity × Kurssi", async () => {
  const draft = opDraft(await opFixture("op-web-paste-sample.txt"));
  const sell = draft.txns[2]!;
  expect(sell.type).toBe("SELL");
  expect(sell.quantity).toBe(15_000_000); // "15,00   kpl"
  expect(sell.unitPrice).toBe(310); // "3,10   EUR" -- rounded for display, not authoritative
  // 15 * 3.10 - 0.45 = 46.05, but the real (never-recomputed) total is 44.55.
  expect(sell.amount).toBe(4455);
});

test("the OP fixture's OSINKO row maps to DIVIDEND, positive amount, and quantity forced to 0", async () => {
  const draft = opDraft(await opFixture("op-web-paste-sample.txt"));
  const dividend = draft.txns[3]!;
  expect(dividend.type).toBe("DIVIDEND");
  expect(dividend.amount).toBe(160); // unsigned "1,60   EUR", signed positive by OSINKO
  // "20,00   kpl" here is shares *held*, not units transacted -- must never
  // flow through as though 20 units were bought or sold on this date.
  expect(dividend.quantity).toBe(0);
  expect(dividend.unitPrice).toBe(8); // "0,08   EUR" -- dividend per share, kept as informational
});

// --- C2 regression: a real, non-zero broker fee must flow end to end from a
// parsed fixture row through to core/costbasis's reported cost basis and
// disposal proceeds without ever being combined with the already
// fee-inclusive `amount` mapRows produced (see `Txn.amount`'s doc in
// core/types.ts). Every fixture row used elsewhere in this file happened to
// carry a zero fee, which is exactly why the double-count bug survived --
// this test is the one that would have caught it.
test("a real OP fixture row's non-zero fee reaches cost basis and disposal proceeds unadjusted, end to end", async () => {
  const draft = opDraft(await opFixture("op-web-paste-sample.txt"));

  const toTxn = (
    row: DraftTxn,
    id: number,
    instrumentId: number,
    overrides: Partial<DraftTxn> = {},
  ): Txn => {
    const merged = { ...row, ...overrides };
    return {
      id,
      accountId: merged.accountId,
      instrumentId,
      // SAFETY: `merged.type` is either OP_WEB_PASTE.typeMap's own "BUY"/"SELL" output
      // (real, validated ledger types -- see mapRows) or this test's own `overrides.type`
      // literal ("BUY"), never arbitrary text, so it is always a real `TransactionType`.
      type: merged.type as TransactionType,
      tradeDate: merged.tradeDate,
      quantity: { scaled: BigInt(merged.quantity) },
      unitPrice:
        merged.unitPrice === null ? null : money(BigInt(merged.unitPrice), merged.currency),
      amount: money(BigInt(merged.amount), merged.currency),
      fee: money(BigInt(merged.fee), merged.currency),
      tax: money(BigInt(merged.tax), merged.currency),
      currency: merged.currency,
      fxRateEur: parseFxRate("1", merged.currency),
    };
  };

  // Row 0: "OP-MAAILMA INDEKSI A" OSTO, 1,2000 kpl x 250,00 EUR, Kulut 0,02
  // EUR, Yhteensä 300,02 EUR -- real fixture bytes. mapRows already folded
  // the fee into `amount` (-300.02); costBasisAt must report that figure
  // as-is, not 300.02 + 0.02 fee again (the C2 bug).
  const buyRow = draft.txns[0]!;
  expect(buyRow.fee).toBe(2);
  expect(buyRow.amount).toBe(-30002);
  const { open } = buildLots([toTxn(buyRow, 1, 900)]);
  expect(open).toHaveLength(1);
  expect(formatMoney(open[0]!.costEur)).toBe("300.02");

  // Row 2: "ESIMERKKI OYJ" MYYNTI, 15,00 kpl @ 3,10 EUR, Kulut 0,45 EUR,
  // Yhteensä 44,55 EUR -- the real, unmodified parsed fee-inclusive SELL.
  // Paired with a synthetic prior BUY (this fixture's own ESIMERKKI row is a
  // bare MYYNTI with no matching purchase on the page -- see op-paste.ts's
  // doc on out-of-order paging) purely so buildLots has a lot to dispose
  // of; only the BUY leg is synthetic, the SELL leg is the real fixture row.
  const sellRow = draft.txns[2]!;
  expect(sellRow.fee).toBe(45);
  expect(sellRow.amount).toBe(4455);
  const priorBuy = toTxn(sellRow, 2, 901, {
    type: "BUY",
    tradeDate: "2025-01-01",
    amount: -100_000,
    fee: 0,
  });
  const { disposals } = buildLots([priorBuy, toTxn(sellRow, 3, 901)]);
  expect(disposals).toHaveLength(1);
  expect(formatMoney(disposals[0]!.proceedsEur)).toBe("44.55");
});

test("every OP fixture row with no ISIN is tracked as unknown by name, never given an invented ISIN", async () => {
  const draft = opDraft(await opFixture("op-web-paste-sample.txt"));
  const names = draft.unknownIsins.map((u) => u.name).sort();
  expect(names).toEqual(["ESIMERKKI OYJ", "OP-MAAILMA INDEKSI A"]);
  expect(draft.unknownIsins.every((u) => u.isin === null)).toBe(true);
});

// --- options.knownNames (Task 20: makes a name-only row resolvable across re-imports) ---

test("resolves a name-only row against options.knownNames, case-insensitively", async () => {
  const draft = opDraft(await opFixture("op-web-paste-sample.txt"), {
    // Deliberately mixed-case, unlike the fixture's all-caps "OP-MAAILMA
    // INDEKSI A" -- proves the match is case-insensitive, not merely an
    // exact-string match that happens to line up.
    knownNames: new Map([["Op-Maailma Indeksi A", 42]]),
  });
  // The fixture's first two rows are both "OP-MAAILMA INDEKSI A" (see
  // op-paste.test.ts's own row ordering) -- both resolve, so only ESIMERKKI
  // OYJ (not in knownNames) is left unknown.
  expect(draft.txns[0]!.instrumentId).toBe(42);
  expect(draft.txns[1]!.instrumentId).toBe(42);
  expect(draft.unknownIsins.map((u) => u.name)).toEqual(["ESIMERKKI OYJ"]);
});

const OP_HEADER = [
  "Laji",
  "Tapahtuma",
  "Tapahtuma-",
  "päivämäärä",
  "Määrä",
  "Kurssi",
  "Kulut / Korot /",
  "Verot",
  "Yhteensä",
  "Toiminnot",
].join("\n");

test("still tracks a name-only row as unknown when knownNames has no match", () => {
  const paste = [
    OP_HEADER,
    "JOKU RAHASTO",
    "OSTO",
    "10.08.2025",
    "1,0000   kpl",
    "10,00   EUR",
    "10,00   EUR",
  ].join("\n");
  const draft = opDraft(paste, {
    knownNames: new Map([["eri rahasto", 1]]),
  });
  expect(draft.txns[0]!.instrumentId).toBeNull();
  expect(draft.unknownIsins).toEqual([{ isin: null, name: "JOKU RAHASTO", currency: EUR }]);
});

test("an unrecognised transaction type becomes a problem, not a guess", () => {
  const rows = [
    rawRow(2, {
      Id: "1",
      Kauppapäivä: "2025-01-10",
      Tapahtumatyyppi: "YHTIÖKOKOUS",
      Arvopaperi: "X",
      ISIN: "FI0009000681",
      Määrä: "0",
      Kurssi: "0",
      Kokonaiskulut: "0",
      Valuutta: "EUR",
      Summa: "0,00",
    }),
  ];
  const draft = mapRows(rows, NORDNET, new Map([["FI0009000681", 7]]));
  expect(draft.txns).toHaveLength(0);
  expect(draft.problems[0]!.line).toBe(2);
  expect(draft.problems[0]!.message).toMatch(/YHTIÖKOKOUS/);
});

test("an unparseable amount becomes a problem carrying the raw row", () => {
  const rows = [
    rawRow(2, {
      Id: "1",
      Kauppapäivä: "2025-01-10",
      Tapahtumatyyppi: "OSTO",
      Arvopaperi: "X",
      ISIN: "FI0009000681",
      Määrä: "10",
      Kurssi: "1,00",
      Kokonaiskulut: "0",
      Valuutta: "EUR",
      Summa: "n/a",
    }),
  ];
  const draft = mapRows(rows, NORDNET, new Map([["FI0009000681", 7]]));
  expect(draft.txns).toHaveLength(0);
  expect(draft.problems[0]!.raw["Summa"]).toBe("n/a");
});

test("content hash is stable for identical rows and differs otherwise", () => {
  const base = {
    accountId: 1,
    instrumentId: 7,
    isin: "FI0009000681",
    type: "BUY" as const,
    tradeDate: "2025-01-10",
    quantity: 100_000_000,
    unitPrice: 415,
    amount: -41800,
    fee: 300,
    tax: 0,
    currency: EUR,
    fxRateEur: 100_000_000,
    externalId: null,
    note: null,
    line: 2,
  };
  expect(contentHash(base)).toBe(contentHash({ ...base, line: 99 }));
  expect(contentHash(base)).not.toBe(contentHash({ ...base, amount: -41801 }));
  // The broker's own text is not part of a row's identity: the same
  // transaction is the same transaction however the export words it. This is
  // what lets a re-import fill in a text the ledger is missing instead of
  // inserting the row a second time.
  expect(contentHash(base)).toBe(contentHash({ ...base, note: "Internal to 123" }));
});

// --- Fix round 1: mapRows options object, contentHash's wider parameter --

test("content hash accepts a row with no line field at all", () => {
  // Mirrors Task 13's opening-balance call, which builds a row with no CSV
  // line to attach and calls contentHash before one exists.
  const { line: _line, ...withoutLine } = {
    accountId: 1,
    instrumentId: 7,
    isin: "FI0009000681",
    type: "BUY" as const,
    tradeDate: "2025-01-10",
    quantity: 100_000_000,
    unitPrice: 415,
    amount: -41800,
    fee: 300,
    tax: 0,
    currency: EUR,
    fxRateEur: 100_000_000,
    externalId: null,
    note: null,
    line: 2,
  };
  expect(contentHash(withoutLine)).toBe(contentHash({ ...withoutLine, line: 2 }));
});

test("mapRows stamps options.accountId onto every draft transaction", () => {
  const csv = `${NORDNET_HEADER}\n${nordnetRow({
    id: "1",
    date: "2025-01-10",
    type: "OSTO",
    name: "NOKIA",
    isin: "FI0009000681",
    qty: "10",
    price: "1,00",
    currency: "EUR",
    amount: "-10,00",
  })}\n`;
  const { rows } = parseCsv(nordnetBytes(csv), NORDNET);
  const draft = mapRows(rows, NORDNET, new Map([["FI0009000681", 7]]), { accountId: 42 });
  expect(draft.txns[0]!.accountId).toBe(42);
});

// --- Additions beyond the brief, for the Task 10 output-shape change -----
//
// Task 10's parseCsv now returns { rows, headers, problems }, where
// `problems` (CsvProblem[]) carries structural failures (bad column count,
// malformed quoting) that never became a RawRow at all. mapRows accepts
// those as an optional 4th argument and folds them into Draft.problems
// alongside its own row-mapping failures, sorted by line, so the review
// screen has one single ordered list of everything wrong with the file.
// See map.ts's DraftProblem for the shape that lets a consumer render
// either kind without a `typeof` check (barred by anti-slop/no-runtime-typeof).

test("merges CSV structural problems into Draft.problems, carrying the raw line text", () => {
  const goodRow = nordnetRow({
    id: "1",
    date: "2025-01-10",
    type: "OSTO",
    name: "NOKIA",
    isin: "FI0009000681",
    qty: "10",
    price: "4,15",
    fee: "3,00",
    currency: "EUR",
    amount: "-41,50",
  });
  const csv = `${NORDNET_HEADER}\n${goodRow}\n2\t3\n`;
  const { rows, problems: csvProblems } = parseCsv(nordnetBytes(csv), NORDNET);
  const draft = mapRows(rows, NORDNET, new Map([["FI0009000681", 7]]), { csvProblems });

  expect(draft.txns).toHaveLength(1);
  expect(draft.problems).toHaveLength(1);
  expect(draft.problems[0]!.line).toBe(3);
  expect(draft.problems[0]!.raw).toEqual({});
  expect(draft.problems[0]!.rawLine).toBe("2\t3");
});

test("keeps structural CSV problems and row-mapping problems together, sorted by line", () => {
  const rows = [
    rawRow(5, {
      Id: "1",
      Kauppapäivä: "2025-01-10",
      Tapahtumatyyppi: "YHTIÖKOKOUS",
      Arvopaperi: "X",
      ISIN: "FI0009000681",
      Määrä: "0",
      Kurssi: "0",
      Kokonaiskulut: "0",
      Valuutta: "EUR",
      Summa: "0,00",
    }),
  ];
  const csvProblems = [{ line: 3, message: "CSV rivi 3: 2 saraketta, odotettiin 30", raw: "2\t3" }];
  const draft = mapRows(rows, NORDNET, new Map(), { csvProblems });

  expect(draft.problems.map((p) => p.line)).toEqual([3, 5]);
  expect(draft.problems[0]!.rawLine).toBe("2\t3");
  expect(draft.problems[0]!.raw).toEqual({});
  expect(draft.problems[1]!.rawLine).toBeUndefined();
  expect(draft.problems[1]!.raw["Tapahtumatyyppi"]).toBe("YHTIÖKOKOUS");
});

test("csvProblems defaults to none when omitted", () => {
  const draft = mapRows([], NORDNET, new Map());
  expect(draft.problems).toEqual([]);
});

// --- Additional branch coverage not exercised by the fixtures above ------

// Any real ISO 4217 code -- including one the real portfolio never held --
// is accepted, not just EUR/USD (§10a A1: the real portfolio holds SEK,
// never USD; GBP here stands in for "some third code" to prove the check
// isn't secretly still a two- or three-member allowlist).
test("any ISO 4217-shaped currency is accepted, not just EUR or USD", () => {
  const rows = [
    rawRow(2, {
      Id: "1",
      Kauppapäivä: "2025-01-10",
      Tapahtumatyyppi: "OSTO",
      Arvopaperi: "X",
      ISIN: "FI0009000681",
      Määrä: "10",
      Kurssi: "1,00",
      Kokonaiskulut: "0",
      Valuutta: "SEK",
      Summa: "10,00",
    }),
  ];
  const draft = mapRows(rows, NORDNET, new Map([["FI0009000681", 7]]));
  expect(draft.problems).toEqual([]);
  expect(draft.txns[0]!.currency).toBe(parseCurrency("SEK"));
});

test("a currency cell not shaped like an ISO 4217 code becomes a problem, not a silent EUR assumption", () => {
  const rows = [
    rawRow(2, {
      Id: "1",
      Kauppapäivä: "2025-01-10",
      Tapahtumatyyppi: "OSTO",
      Arvopaperi: "X",
      ISIN: "FI0009000681",
      Määrä: "10",
      Kurssi: "1,00",
      Kokonaiskulut: "0",
      Valuutta: "12",
      Summa: "10,00",
    }),
  ];
  const draft = mapRows(rows, NORDNET, new Map([["FI0009000681", 7]]));
  expect(draft.txns).toHaveLength(0);
  expect(draft.problems[0]!.message).toMatch(/12/);
});

test("an empty unit-price cell yields no unit price, distinct from a literal 0", () => {
  const rows = [
    rawRow(2, {
      Id: "1",
      Kauppapäivä: "2025-01-10",
      Tapahtumatyyppi: "PALKKIO",
      Arvopaperi: "",
      ISIN: "",
      Määrä: "",
      Kurssi: "",
      Kokonaiskulut: "5,00",
      Valuutta: "EUR",
      Summa: "-5,00",
    }),
  ];
  // NORDNET's real typeMap has no "palkkio" label (see fixtures/broker-mappings.ts -- only
  // the 13 labels actually observed in the real export are mapped). This
  // test only cares about the empty-vs-zero unit-price distinction, so it
  // overrides typeMap locally rather than asserting on an invented label.
  const draft = mapRows(rows, { ...NORDNET, typeMap: { palkkio: "FEE" } }, new Map());
  expect(draft.txns[0]!.unitPrice).toBeNull();
  expect(draft.txns[0]!.quantity).toBe(0);
  expect(draft.txns[0]!.fee).toBe(500);
});

// --- Task 15: duplicate-column addressing and per-broker amount signing --

test("cell() prefers columnPositions over columns when both could apply", () => {
  // A config carrying both a name mapping (which, given the duplicate-name
  // header below, would resolve to the *wrong* occurrence) and a
  // positional one for the same field: the positional one must win.
  const header = ["Tapahtumatyyppi", "Kauppapäivä", "ISIN", "Valuutta", "Summa", "Valuutta"].join(
    "\t",
  );
  const row = ["OSTO", "2025-01-10", "FI0009000681", "EUR", "-10,00", "USD"].join("\t");
  const { rows } = parseCsv(nordnetBytes(`${header}\n${row}\n`), NORDNET);
  const config = {
    ...NORDNET,
    columns: { ...NORDNET.columns, currency: "Valuutta" },
    columnPositions: { currency: 4 }, // 1-based: the first "Valuutta"
  };
  const draft = mapRows(rows, config, new Map());
  expect(draft.txns[0]!.currency).toBe(EUR);
});

test("stripUnitSuffixes leaves a bare number (no suffix) unchanged", () => {
  // The OP fixture's own rows already exercise the suffix-stripping path;
  // this confirms a cell with no suffix at all still parses.
  const rows = [
    {
      line: 2,
      values: {
        Laji: "Test Fund",
        Tapahtuma: "OSTO",
        Tapahtumapäivämäärä: "01.01.2025",
        Määrä: "1,0000",
        Kurssi: "100,00",
        "Kulut / Korot / Verot": "",
        Yhteensä: "100,00",
      },
      cells: [],
    },
  ];
  const draft = mapRows(rows, OP_WEB_PASTE, new Map());
  expect(draft.txns[0]!.quantity).toBe(1_000_000);
  expect(draft.txns[0]!.amount).toBe(-10000);
});

// A second, wider Nordnet export (2026-08-28) covering a second account carried
// five transaction-type labels the first one never showed. These map the ones
// that can be booked from a single row; the paired-leg events below stay
// unmapped on purpose -- see fixtures/broker-mappings.ts's own typeMap comment.
test("maps the labels a second Nordnet account introduced: dividend, equity-savings cash legs, withheld tax", () => {
  const csv = [
    NORDNET_HEADER,
    nordnetRow({
      id: "1",
      date: "2025-03-11",
      type: "OSINKO",
      name: "Esimerkki Oyj",
      isin: "FI0009007132",
      qty: "12",
      price: "2",
      amount: "24",
    }),
    nordnetRow({ id: "2", date: "2025-03-12", type: "TALLETUS OST.", amount: "500" }),
    nordnetRow({ id: "3", date: "2025-03-13", type: "NOSTO OST.", amount: "-120" }),
    nordnetRow({ id: "4", date: "2025-03-13", type: "PÄÄOMATULOVERO OST", amount: "-15" }),
  ].join("\r\n");

  const { rows, problems } = parseCsv(nordnetBytes(csv), NORDNET);
  expect(problems).toEqual([]);
  const draft = mapRows(rows, NORDNET, new Map([["FI0009007132", 7]]));
  expect(draft.problems).toEqual([]);
  expect(draft.txns.map((t) => t.type)).toEqual(["DIVIDEND", "DEPOSIT", "WITHDRAWAL", "FEE"]);

  // A dividend's "Määrä" is shares *held*, not units bought, so it must never
  // move the position -- map.ts forces it to zero regardless of the cell.
  expect(draft.txns[0]!.quantity).toBe(0);
  expect(draft.txns[0]!.amount).toBe(2400);
  // Withheld capital income tax is a cost, not money the investor received.
  expect(draft.txns[3]!.amount).toBe(-1500);
});

test("maps a share swap to a transfer pair, carrying the acquisition value across", () => {
  const csv = [
    NORDNET_HEADER,
    nordnetRow({
      id: "1",
      date: "2019-10-04",
      type: "VAIHTO AP-OTTO",
      name: "Vanha ETF",
      isin: "IE00BG5J1M21",
      qty: "30",
      price: "0",
      amount: "0",
    }),
    (() => {
      // `Hankinta-arvo` is column 16 (1-based), which nordnetRow leaves blank.
      const cells = nordnetRow({
        id: "2",
        date: "2019-10-04",
        type: "VAIHTO AP-JÄTTÖ",
        name: "Uusi ETF",
        isin: "IE00BJQTJ848",
        qty: "12,5952",
        amount: "0",
      }).split("\t");
      cells[15] = "300,0000";
      return cells.join("\t");
    })(),
  ].join("\r\n");

  const draft = mapRows(
    parseCsv(nordnetBytes(csv), NORDNET).rows,
    NORDNET,
    new Map([
      ["IE00BG5J1M21", 1],
      ["IE00BJQTJ848", 2],
    ]),
  );
  expect(draft.problems).toEqual([]);
  expect(draft.txns.map((t) => t.type)).toEqual(["TRANSFER_OUT", "TRANSFER_IN"]);
  expect(draft.txns[0]!.amount).toBe(0);
  // Negative, matching the ledger's convention that an acquisition's amount is
  // the cash that left -- buildLots reads the cost basis from `-amount`, so a
  // zero here would report the whole holding as gain.
  expect(draft.txns[1]!.amount).toBe(-30000);
  expect(draft.txns[1]!.quantity).toBe(12_595_200);
});

test("books the leg that carries both quantity and cash, and reports its cash-only twin as skipped", () => {
  const csv = [
    NORDNET_HEADER,
    nordnetRow({
      id: "1",
      date: "2019-10-10",
      type: "DESIM KIRJAUS OTTO",
      name: "ETF",
      isin: "IE00BJQTJ848",
      qty: "0,5952",
      price: "6,116",
      amount: "3,64",
    }),
    nordnetRow({
      id: "2",
      date: "2019-10-10",
      type: "DESIM. ULOSKIRJ. KÄT",
      name: "ETF",
      isin: "IE00BJQTJ848",
      qty: "0,5952",
      price: "6,116",
      amount: "3,64",
    }),
    nordnetRow({
      id: "3",
      date: "2022-04-14",
      type: "LUNASTUS AP OTTO",
      name: "Lunastus",
      isin: "FI4000233267",
      qty: "15",
      price: "2,1",
      amount: "31,5",
    }),
    nordnetRow({
      id: "4",
      date: "2022-04-14",
      type: "LUNASTUS AP KÄT.",
      name: "Lunastus",
      isin: "FI4000233267",
      qty: "15",
      price: "2,1",
      amount: "31,5",
    }),
  ].join("\r\n");

  const draft = mapRows(
    parseCsv(nordnetBytes(csv), NORDNET).rows,
    NORDNET,
    new Map([
      ["IE00BJQTJ848", 2],
      ["FI4000233267", 3],
    ]),
  );
  expect(draft.txns.map((t) => t.type)).toEqual(["SELL", "SELL"]);
  expect(draft.txns[0]!.amount).toBe(364);
  expect(draft.txns[1]!.amount).toBe(3150);
  // The twins are reported, not silently dropped -- and say why.
  expect(draft.problems).toHaveLength(2);
  expect(draft.problems.every((p) => p.message.includes("käteispuoli"))).toBe(true);
});

// A 2023 rights issue and a 2024 reverse split, as OP's web view renders
// them. The whole sequence has to reconcile: 120 shares, 900 subscribed,
// consolidated onto the ordinary line, reverse split to 18, then sold.
test("maps OP's corporate actions so a reverse split lands on the right share count", () => {
  const block = (lines: string[]) => lines.join("\n");
  const text = [
    block([
      "Laji",
      "Tapahtuma",
      "Tapahtuma-",
      "päivämäärä",
      "Määrä",
      "Kurssi",
      "Kulut / Korot /",
      "Verot",
      "Yhteensä",
    ]),
    "",
    block([
      "ESIMERKKI OYJ/SH NV",
      "MERKINTÄ",
      "03.11.2019",
      "900,00   kpl",
      "0,00   EUR",
      "27,00   EUR",
    ]),
    "",
    block(["ESIMERKKI OYJ/SUBS RTS 2023", "IRROTUS - JÄTTÖ", "30.10.2019", "120,00   kpl"]),
    "",
    block(["ESIMERKKI OYJ/SH NV", "YHDISTELY - OTTO", "24.11.2019", "900,00   kpl"]),
    "",
    block(["ESIMERKKI OYJ", "YHDISTELY - JÄTTÖ", "24.11.2019", "900,00   kpl"]),
    "",
    block(["ESIMERKKI OYJ", "VAIHTO - OTTO", "21.03.2020", "1 000,00   kpl"]),
    "",
    block(["ESIMERKKI OYJ", "VAIHTO - JÄTTÖ", "21.03.2020", "18,00   kpl"]),
  ].join("\n");

  const draft = opDraft(text, {
    knownNames: new Map([
      ["ESIMERKKI OYJ", 1],
      ["ESIMERKKI OYJ/SH NV", 2],
      ["ESIMERKKI OYJ/SUBS RTS 2023", 3],
    ]),
  });

  expect(draft.txns.map((t) => t.type)).toEqual(["BUY", "TRANSFER_OUT", "TRANSFER_IN", "SPLIT"]);
  // The subscription costs cash, so its amount must be negative.
  expect(draft.txns[0]!.amount).toBe(-2700);
  // SPLIT's quantity is the resulting total, which is what the JÄTTÖ leg states.
  expect(draft.txns[3]!.quantity).toBe(18_000_000);
  // Rights in, rights out, and the split's pre-split count are all reported.
  expect(draft.problems).toHaveLength(2);
});

// The transaction type alone cannot say what a cash movement was: a transfer to
// another of the owner's own accounts, the cash leg of a subscription that
// returns days later, and money genuinely leaving all arrive as the same label
// and amount. Nordnet says which in `Tapahtumateksti`, and the importer used to
// drop it -- which left the equity savings account's tax figures resting on
// structural guesswork.
test("keeps the broker's own text for a row", () => {
  const csv = [
    NORDNET_HEADER,
    nordnetRow({
      id: "1",
      date: "2025-03-13",
      type: "NOSTO OST.",
      amount: "-120",
      text: "Internal to 12345678",
    }),
  ].join("\r\n");

  const { rows } = parseCsv(nordnetBytes(csv), NORDNET);
  const draft = mapRows(rows, NORDNET, new Map());

  expect(draft.problems).toEqual([]);
  expect(draft.txns[0]!.note).toBe("Internal to 12345678");
});

test("leaves the text null when the export carries none", () => {
  const csv = [
    NORDNET_HEADER,
    nordnetRow({ id: "1", date: "2025-03-13", type: "TALLETUS", amount: "500" }),
  ].join("\r\n");

  const { rows } = parseCsv(nordnetBytes(csv), NORDNET);
  const draft = mapRows(rows, NORDNET, new Map());

  // Null, not an empty string: "nobody wrote one" and "they wrote nothing" are
  // the same fact here, and null is how the rest of the ledger says it.
  expect(draft.txns[0]!.note).toBeNull();
});

// A US share bought through a Finnish broker is priced in USD and paid for in
// EUR. Reading one currency for both made the price EUR, and instrument
// resolution -- which picks a listing by the holding's own currency -- then put
// a US share on a European listing, priced it from the wrong exchange, and
// carried no history from before that listing existed.
test("a trade priced abroad keeps the instrument's own currency, not the cash's", () => {
  const csv = [
    NORDNET_HEADER,
    nordnetRow({
      id: "1",
      date: "2025-03-14",
      type: "OSTO",
      name: "Example Corp",
      isin: "US0000000000",
      qty: "4",
      price: "28,30",
      amount: "-94,91",
      settled: "EUR",
      priceCurrency: "USD",
    }),
  ].join("\r\n");

  const { rows } = parseCsv(nordnetBytes(csv), NORDNET);
  const draft = mapRows(rows, NORDNET, new Map());

  expect(draft.problems).toEqual([]);
  // The cash that moved is EUR -- that is what left the account.
  expect(draft.txns[0]!.currency).toBe(EUR);
  expect(draft.txns[0]!.amount).toBe(-9491);
  // The price is 28,30 USD, and the unresolved instrument is offered for
  // resolution as a USD one, so it gets a US listing rather than a European
  // one that happens to quote the same ISIN.
  expect(draft.txns[0]!.unitPrice).toBe(2830);
  expect(draft.unknownIsins[0]!.currency).toBe(parseCurrency("USD"));
});

test("a domestic trade still resolves in the currency it settled in", () => {
  const csv = [
    NORDNET_HEADER,
    nordnetRow({
      id: "1",
      date: "2025-03-14",
      type: "OSTO",
      name: "Kotimainen Oyj",
      isin: "FI0000000000",
      qty: "10",
      price: "5,00",
      amount: "-50,00",
      settled: "EUR",
    }),
  ].join("\r\n");

  const { rows } = parseCsv(nordnetBytes(csv), NORDNET);
  const draft = mapRows(rows, NORDNET, new Map());

  // No separate price currency stated: the settlement currency stands.
  expect(draft.unknownIsins[0]!.currency).toBe(EUR);
});
