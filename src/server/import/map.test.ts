import { test, expect } from "bun:test";
import { mapRows, normaliseDate, contentHash } from "./map";
import { parseCsv } from "./csv";
import { NORDNET, OP } from "./brokers";

const fixture = (name: string) => Bun.file(`${import.meta.dir}/fixtures/${name}`).arrayBuffer();

test("normalises both date formats to ISO", () => {
  expect(normaliseDate("2025-01-10", "iso")).toBe("2025-01-10");
  expect(normaliseDate("15.01.2025", "fi")).toBe("2025-01-15");
  expect(() => normaliseDate("32.01.2025", "fi")).toThrow();
  expect(() => normaliseDate("", "iso")).toThrow();
});

test("maps the Nordnet fixture into draft transactions", async () => {
  const { rows } = parseCsv(await fixture("nordnet-sample.csv"), NORDNET);
  const known = new Map([["FI0009000681", 7]]);
  const draft = mapRows(rows, NORDNET, known);

  expect(draft.problems).toEqual([]);
  expect(draft.txns).toHaveLength(5);

  const buy = draft.txns[0]!;
  expect(buy.type).toBe("BUY");
  expect(buy.tradeDate).toBe("2025-01-10");
  expect(buy.instrumentId).toBe(7);
  expect(buy.quantity).toBe(100_000_000); // 100 units, scaled 1e6
  expect(buy.unitPrice).toBe(415); // 4,15 EUR
  expect(buy.amount).toBe(-41800);
  expect(buy.fee).toBe(300);
  expect(buy.currency).toBe("EUR");
});

test("a deposit has no instrument and no quantity", async () => {
  const { rows } = parseCsv(await fixture("nordnet-sample.csv"), NORDNET);
  const draft = mapRows(rows, NORDNET, new Map([["FI0009000681", 7]]));
  const deposit = draft.txns.find((t) => t.type === "DEPOSIT")!;
  expect(deposit.instrumentId).toBeNull();
  expect(deposit.quantity).toBe(0);
  expect(deposit.amount).toBe(500000);
});

test("collects ISINs it has never seen instead of inventing instruments", async () => {
  const { rows } = parseCsv(await fixture("nordnet-sample.csv"), NORDNET);
  const draft = mapRows(rows, NORDNET, new Map([["FI0009000681", 7]]));
  expect(draft.unknownIsins).toEqual([{ isin: "IE00B4L5Y983", name: "ISHARES CORE MSCI WORLD" }]);
  expect(draft.txns.find((t) => t.isin === "IE00B4L5Y983")!.instrumentId).toBeNull();
});

test("maps the OP fixture with fi dates and fractional fund units", async () => {
  const { rows } = parseCsv(await fixture("op-sample.csv"), OP);
  const draft = mapRows(rows, OP, new Map([["FI0008803812", 3]]));
  const subscription = draft.txns[0]!;
  expect(subscription.type).toBe("BUY");
  expect(subscription.tradeDate).toBe("2025-01-15");
  expect(subscription.quantity).toBe(12_345_600);
  expect(subscription.amount).toBe(-18827);
});

test("an unrecognised transaction type becomes a problem, not a guess", () => {
  const rows = [
    {
      line: 2,
      values: {
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
      },
    },
  ];
  const draft = mapRows(rows, NORDNET, new Map([["FI0009000681", 7]]));
  expect(draft.txns).toHaveLength(0);
  expect(draft.problems[0]!.line).toBe(2);
  expect(draft.problems[0]!.message).toMatch(/YHTIÖKOKOUS/);
});

test("an unparseable amount becomes a problem carrying the raw row", () => {
  const rows = [
    {
      line: 2,
      values: {
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
      },
    },
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
    currency: "EUR" as const,
    fxRateEur: 100_000_000,
    externalId: null,
    line: 2,
  };
  expect(contentHash(base)).toBe(contentHash({ ...base, line: 99 }));
  expect(contentHash(base)).not.toBe(contentHash({ ...base, amount: -41801 }));
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
  const csv =
    "Id;Kauppapäivä;Tapahtumatyyppi;Arvopaperi;ISIN;Määrä;Kurssi;Kokonaiskulut;Valuutta;Summa\n" +
    "1;2025-01-10;OSTO;NOKIA;FI0009000681;10;4,15;3,00;EUR;-41,50\n" +
    "2;3\n";
  const { rows, problems: csvProblems } = parseCsv(new TextEncoder().encode(csv).buffer, NORDNET);
  const draft = mapRows(rows, NORDNET, new Map([["FI0009000681", 7]]), csvProblems);

  expect(draft.txns).toHaveLength(1);
  expect(draft.problems).toHaveLength(1);
  expect(draft.problems[0]!.line).toBe(3);
  expect(draft.problems[0]!.raw).toEqual({});
  expect(draft.problems[0]!.rawLine).toBe("2;3");
});

test("keeps structural CSV problems and row-mapping problems together, sorted by line", () => {
  const rows = [
    {
      line: 5,
      values: {
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
      },
    },
  ];
  const csvProblems = [{ line: 3, message: "CSV rivi 3: 2 saraketta, odotettiin 10", raw: "2;3" }];
  const draft = mapRows(rows, NORDNET, new Map(), csvProblems);

  expect(draft.problems.map((p) => p.line)).toEqual([3, 5]);
  expect(draft.problems[0]!.rawLine).toBe("2;3");
  expect(draft.problems[0]!.raw).toEqual({});
  expect(draft.problems[1]!.rawLine).toBeUndefined();
  expect(draft.problems[1]!.raw["Tapahtumatyyppi"]).toBe("YHTIÖKOKOUS");
});

test("csvProblems defaults to none when omitted", () => {
  const draft = mapRows([], NORDNET, new Map());
  expect(draft.problems).toEqual([]);
});

// --- Additional branch coverage not exercised by the fixtures above ------

test("an unsupported currency becomes a problem, not a silent EUR assumption", () => {
  const rows = [
    {
      line: 2,
      values: {
        Id: "1",
        Kauppapäivä: "2025-01-10",
        Tapahtumatyyppi: "OSTO",
        Arvopaperi: "X",
        ISIN: "FI0009000681",
        Määrä: "10",
        Kurssi: "1,00",
        Kokonaiskulut: "0",
        Valuutta: "GBP",
        Summa: "10,00",
      },
    },
  ];
  const draft = mapRows(rows, NORDNET, new Map([["FI0009000681", 7]]));
  expect(draft.txns).toHaveLength(0);
  expect(draft.problems[0]!.message).toMatch(/GBP/);
});

test("an empty unit-price cell yields no unit price, distinct from a literal 0", () => {
  const rows = [
    {
      line: 2,
      values: {
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
      },
    },
  ];
  const draft = mapRows(rows, NORDNET, new Map());
  expect(draft.txns[0]!.unitPrice).toBeNull();
  expect(draft.txns[0]!.quantity).toBe(0);
  expect(draft.txns[0]!.fee).toBe(500);
});
