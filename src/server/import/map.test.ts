import { test, expect } from "bun:test";
import { mapRows, normaliseDate, contentHash } from "./map";
import { parseCsv } from "./csv";
import { parseOpPaste } from "./op-paste";
import { NORDNET, OP_WEB_PASTE } from "./brokers";
import { EUR, parseCurrency } from "../../core/money";
import type { RawRow } from "./types";

const fixture = (name: string) => Bun.file(`${import.meta.dir}/fixtures/${name}`).arrayBuffer();
const opFixture = (name: string) => Bun.file(`${import.meta.dir}/fixtures/${name}`).text();

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
  c[14] = "EUR";
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
  Valuutta: 12,
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

test("normalises both date formats to ISO", () => {
  expect(normaliseDate("2025-01-10", "iso")).toBe("2025-01-10");
  expect(normaliseDate("15.01.2025", "fi")).toBe("2025-01-15");
  expect(() => normaliseDate("32.01.2025", "fi")).toThrow();
  expect(() => normaliseDate("", "iso")).toThrow();
});

test("maps the real-format Nordnet fixture into draft transactions", async () => {
  const { rows } = parseCsv(await fixture("nordnet-sample.csv"), NORDNET);
  const known = new Map([["IE0002Y8CX98", 7]]);
  const draft = mapRows(rows, NORDNET, known);

  // 4 of the fixture's 13 rows are deliberately unmapped: the VAIHTO
  // merger pair and the two DESIM rows -- see below and brokers.ts.
  expect(draft.problems).toHaveLength(4);
  expect(draft.txns).toHaveLength(9);

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

// Review finding: an earlier version of this config mapped VAIHTO
// AP-OTTO/AP-JÄTTÖ to TRANSFER_OUT/TRANSFER_IN with `amount: 0` (matching
// the real `Summa`). That silently booked the merged-in holding at EUR 0
// acquisition cost in core/costbasis.ts (which derives a TRANSFER_IN lot's
// cost from `-amount`), so its entire eventual sale would be reported as
// gain -- see brokers.ts's typeMap comment for the full reasoning on why
// no field in DraftTxn can carry the real cost basis (Hankinta-arvo)
// without a different corruption. Left unmapped instead, alongside DESIM.
test("the VAIHTO merger pair is left unmapped and surfaces as problems, not booked at a wrong cost basis", async () => {
  const { rows } = parseCsv(await fixture("nordnet-sample.csv"), NORDNET);
  const draft = mapRows(rows, NORDNET, new Map());
  expect(draft.txns.some((t) => t.type === "TRANSFER_OUT" || t.type === "TRANSFER_IN")).toBe(false);
  expect(draft.problems.some((p) => p.raw["Tapahtumatyyppi"] === "VAIHTO AP-OTTO")).toBe(true);
  expect(draft.problems.some((p) => p.raw["Tapahtumatyyppi"] === "VAIHTO AP-JÄTTÖ")).toBe(true);
});

test("the two DESIM rows are left unmapped and surface as problems, not guesses", async () => {
  const { rows } = parseCsv(await fixture("nordnet-sample.csv"), NORDNET);
  const draft = mapRows(rows, NORDNET, new Map());
  expect(draft.problems).toHaveLength(4); // VAIHTO AP-OTTO, VAIHTO AP-JÄTTÖ, and the two DESIM rows
  expect(draft.problems.every((p) => p.message.includes("Tuntematon tapahtumatyyppi"))).toBe(true);
  expect(draft.problems.some((p) => p.raw["Tapahtumatyyppi"] === "DESIM. ULOSKIRJ. KÄT")).toBe(
    true,
  );
  expect(draft.problems.some((p) => p.raw["Tapahtumatyyppi"] === "DESIM KIRJAUS OTTO")).toBe(true);
});

test("collects ISINs it has never seen instead of inventing instruments", async () => {
  const { rows } = parseCsv(await fixture("nordnet-sample.csv"), NORDNET);
  const draft = mapRows(rows, NORDNET, new Map([["IE0002Y8CX98", 7]]));
  // Only the MYYNTI row's ISIN reaches unknown-instrument tracking at all:
  // an unmapped type (VAIHTO, DESIM) throws at the typeMap lookup, before
  // isin/name extraction ever runs -- see mapRows.
  const isins = draft.unknownIsins.map((u) => u.isin).sort();
  expect(isins).toEqual(["SE0005993102"]);
  expect(draft.txns.find((t) => t.isin === "SE0005993102")!.instrumentId).toBeNull();
});

// --- OP web-paste (op-paste.ts's own shape-anchored parser, not parseCsv) --

test("maps the OP fixture's OSTO-with-fee row: fi dates, unit suffixes, and a name-only instrument", async () => {
  const { rows } = parseOpPaste(await opFixture("op-web-paste-sample.txt"));
  const draft = mapRows(rows, OP_WEB_PASTE, new Map());
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
  const { rows } = parseOpPaste(await opFixture("op-web-paste-sample.txt"));
  const draft = mapRows(rows, OP_WEB_PASTE, new Map());
  const noFee = draft.txns[1]!;
  expect(noFee.fee).toBe(0);
  expect(noFee.amount).toBe(-30000);
});

test("the OP fixture's MYYNTI row: unsigned total re-signed positive, never cross-checked against quantity × Kurssi", async () => {
  const { rows } = parseOpPaste(await opFixture("op-web-paste-sample.txt"));
  const draft = mapRows(rows, OP_WEB_PASTE, new Map());
  const sell = draft.txns[2]!;
  expect(sell.type).toBe("SELL");
  expect(sell.quantity).toBe(15_000_000); // "15,00   kpl"
  expect(sell.unitPrice).toBe(310); // "3,10   EUR" -- rounded for display, not authoritative
  // 15 * 3.10 - 0.45 = 46.05, but the real (never-recomputed) total is 44.55.
  expect(sell.amount).toBe(4455);
});

test("the OP fixture's OSINKO row maps to DIVIDEND, positive amount, and quantity forced to 0", async () => {
  const { rows } = parseOpPaste(await opFixture("op-web-paste-sample.txt"));
  const draft = mapRows(rows, OP_WEB_PASTE, new Map());
  const dividend = draft.txns[3]!;
  expect(dividend.type).toBe("DIVIDEND");
  expect(dividend.amount).toBe(160); // unsigned "1,60   EUR", signed positive by OSINKO
  // "20,00   kpl" here is shares *held*, not units transacted -- must never
  // flow through as though 20 units were bought or sold on this date.
  expect(dividend.quantity).toBe(0);
  expect(dividend.unitPrice).toBe(8); // "0,08   EUR" -- dividend per share, kept as informational
});

test("every OP fixture row with no ISIN is tracked as unknown by name, never given an invented ISIN", async () => {
  const { rows } = parseOpPaste(await opFixture("op-web-paste-sample.txt"));
  const draft = mapRows(rows, OP_WEB_PASTE, new Map());
  const names = draft.unknownIsins.map((u) => u.name).sort();
  expect(names).toEqual(["ESIMERKKI OYJ", "OP-MAAILMA INDEKSI A"]);
  expect(draft.unknownIsins.every((u) => u.isin === null)).toBe(true);
});

// --- options.knownNames (Task 20: makes a name-only row resolvable across re-imports) ---

test("resolves a name-only row against options.knownNames, case-insensitively", async () => {
  const { rows } = parseOpPaste(await opFixture("op-web-paste-sample.txt"));
  const draft = mapRows(rows, OP_WEB_PASTE, new Map(), {
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
  const { rows } = parseOpPaste(paste);
  const draft = mapRows(rows, OP_WEB_PASTE, new Map(), {
    knownNames: new Map([["eri rahasto", 1]]),
  });
  expect(draft.txns[0]!.instrumentId).toBeNull();
  expect(draft.unknownIsins).toEqual([{ isin: null, name: "JOKU RAHASTO" }]);
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
    line: 2,
  };
  expect(contentHash(base)).toBe(contentHash({ ...base, line: 99 }));
  expect(contentHash(base)).not.toBe(contentHash({ ...base, amount: -41801 }));
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
  // NORDNET's real typeMap has no "palkkio" label (see brokers.ts -- only
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
