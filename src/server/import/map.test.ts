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

const opDraft = (text: string, options: { knownNames?: Map<string, number> } = {}) =>
  runBrokerRecord(
    text,
    OP_PASTE_RECIPE,
    { knownIsins: new Map(), knownNames: options.knownNames ?? new Map() },
    0,
  ).draft;

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
  text?: string;
  settled?: string;
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

const REAL_INDEX = {
  Id: 0,
  Kauppapäivä: 2,
  Tapahtumatyyppi: 5,
  Arvopaperi: 6,
  ISIN: 7,
  Määrä: 8,
  Kurssi: 9,
  Kokonaiskulut: 11,
  Valuutta: 14,
  Summa: 13,
} satisfies Record<string, number>;

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
  expect(normaliseDate("15.01.2025", "dmy")).toBe("2025-01-15");
  expect(() => normaliseDate("32.01.2025", "dmy")).toThrow();
  expect(() => normaliseDate("", "iso")).toThrow();
});

test("maps the real-format Nordnet fixture into draft transactions", async () => {
  const { rows } = parseCsv(await fixture("nordnet-sample.csv"), NORDNET);
  const known = new Map([["IE0002Y8CX98", 7]]);
  const draft = mapRows(rows, NORDNET, known);

  expect(draft.problems).toHaveLength(1);
  expect(draft.txns).toHaveLength(12);

  const buy = draft.txns[0]!;
  expect(buy.type).toBe("BUY");
  expect(buy.tradeDate).toBe("2025-01-10");
  expect(buy.instrumentId).toBe(7);
  expect(buy.quantity).toBe(2_000_000);
  expect(buy.unitPrice).toBe(3400);
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

test("the real-time deposit and plain deposit labels both map to DEPOSIT", async () => {
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
  expect(fees.some((t) => t.amount < 0)).toBe(true);
  expect(fees.some((t) => t.amount > 0)).toBe(true);
});

test("overdraft and loan interest labels both map to INTEREST", async () => {
  const { rows } = parseCsv(await fixture("nordnet-sample.csv"), NORDNET);
  const draft = mapRows(rows, NORDNET, new Map());
  expect(draft.txns.filter((t) => t.type === "INTEREST")).toHaveLength(2);
});

test("the share-swap pair is booked as a transfer pair, with the acquisition value carried across", async () => {
  const { rows } = parseCsv(await fixture("nordnet-sample.csv"), NORDNET);
  const draft = mapRows(rows, NORDNET, new Map());
  expect(draft.txns.some((t) => t.type === "TRANSFER_OUT")).toBe(true);
  expect(draft.txns.some((t) => t.type === "TRANSFER_IN")).toBe(true);
  const transferIn = draft.txns.find((t) => t.type === "TRANSFER_IN")!;
  expect(transferIn.amount).toBeLessThan(0);
});

test("the fractional-share pair books one disposal and reports its cash-only twin as skipped", async () => {
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
  const isins = draft.unknownIsins.map((u) => u.isin);
  expect(isins).toContain("SE0005993102");
  expect(draft.txns.find((t) => t.isin === "SE0005993102")!.instrumentId).toBeNull();
});

test("maps the OP fixture's buy-with-fee row: day-first dates, unit suffixes, and a name-only instrument", async () => {
  const draft = opDraft(await opFixture("op-web-paste-sample.txt"));
  expect(draft.problems).toEqual([]);
  expect(draft.txns).toHaveLength(4);

  const buy = draft.txns[0]!;
  expect(buy.type).toBe("BUY");
  expect(buy.tradeDate).toBe("2025-08-10");
  expect(buy.quantity).toBe(1_200_000);
  expect(buy.unitPrice).toBe(25000);
  expect(buy.fee).toBe(2);
  expect(buy.amount).toBe(-30002);
  expect(buy.isin).toBeNull();
});

test("the OP fixture's buy-without-fee row (the fee line is absent, not blank) still parses", async () => {
  const draft = opDraft(await opFixture("op-web-paste-sample.txt"));
  const noFee = draft.txns[1]!;
  expect(noFee.fee).toBe(0);
  expect(noFee.amount).toBe(-30000);
});

test("the OP fixture's sale row: unsigned total re-signed positive, never cross-checked against quantity × price", async () => {
  const draft = opDraft(await opFixture("op-web-paste-sample.txt"));
  const sell = draft.txns[2]!;
  expect(sell.type).toBe("SELL");
  expect(sell.quantity).toBe(15_000_000);
  expect(sell.unitPrice).toBe(310);
  expect(sell.amount).toBe(4455);
});

test("the OP fixture's dividend row maps to DIVIDEND, positive amount, and quantity forced to 0", async () => {
  const draft = opDraft(await opFixture("op-web-paste-sample.txt"));
  const dividend = draft.txns[3]!;
  expect(dividend.type).toBe("DIVIDEND");
  expect(dividend.amount).toBe(160);
  expect(dividend.quantity).toBe(0);
  expect(dividend.unitPrice).toBe(8);
});

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
      // SAFETY: the body has the shape the route returns.
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

  const buyRow = draft.txns[0]!;
  expect(buyRow.fee).toBe(2);
  expect(buyRow.amount).toBe(-30002);
  const { open } = buildLots([toTxn(buyRow, 1, 900)]);
  expect(open).toHaveLength(1);
  expect(formatMoney(open[0]!.costEur)).toBe("300.02");

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

test("resolves a name-only row against options.knownNames, case-insensitively", async () => {
  const draft = opDraft(await opFixture("op-web-paste-sample.txt"), {
    knownNames: new Map([["Op-Maailma Indeksi A", 42]]),
  });
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
    knownNames: new Map([["other fund", 1]]),
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
  expect(contentHash(base)).toBe(contentHash({ ...base, note: "Internal to 123" }));
});

test("content hash accepts a row with no line field at all", () => {
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
  const csvProblems = [{ line: 3, message: "CSV line 3: 2 columns, expected 30", raw: "2\t3" }];
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
  const draft = mapRows(rows, { ...NORDNET, typeMap: { palkkio: "FEE" } }, new Map());
  expect(draft.txns[0]!.unitPrice).toBeNull();
  expect(draft.txns[0]!.quantity).toBe(0);
  expect(draft.txns[0]!.fee).toBe(500);
});

test("cell() prefers columnPositions over columns when both could apply", () => {
  const header = ["Tapahtumatyyppi", "Kauppapäivä", "ISIN", "Valuutta", "Summa", "Valuutta"].join(
    "\t",
  );
  const row = ["OSTO", "2025-01-10", "FI0009000681", "EUR", "-10,00", "USD"].join("\t");
  const { rows } = parseCsv(nordnetBytes(`${header}\n${row}\n`), NORDNET);
  const config = {
    ...NORDNET,
    columns: { ...NORDNET.columns, currency: "Valuutta" },
    columnPositions: { currency: 4 },
  };
  const draft = mapRows(rows, config, new Map());
  expect(draft.txns[0]!.currency).toBe(EUR);
});

test("stripUnitSuffixes leaves a bare number (no suffix) unchanged", () => {
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

test("maps the labels a second Nordnet account introduced: dividend, equity-savings cash legs, withheld tax", () => {
  const csv = [
    NORDNET_HEADER,
    nordnetRow({
      id: "1",
      date: "2025-03-11",
      type: "OSINKO",
      name: "Example Oyj",
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

  expect(draft.txns[0]!.quantity).toBe(0);
  expect(draft.txns[0]!.amount).toBe(2400);
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
  expect(draft.problems).toHaveLength(2);
  expect(draft.problems.every((p) => p.message.includes("Cash side"))).toBe(true);
});

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
  expect(draft.txns[0]!.amount).toBe(-2700);
  expect(draft.txns[3]!.quantity).toBe(18_000_000);
  expect(draft.problems).toHaveLength(2);
});

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

  expect(draft.txns[0]!.note).toBeNull();
});

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
  expect(draft.txns[0]!.currency).toBe(EUR);
  expect(draft.txns[0]!.amount).toBe(-9491);
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
      name: "Domestic Oyj",
      isin: "FI0000000000",
      qty: "10",
      price: "5,00",
      amount: "-50,00",
      settled: "EUR",
    }),
  ].join("\r\n");

  const { rows } = parseCsv(nordnetBytes(csv), NORDNET);
  const draft = mapRows(rows, NORDNET, new Map());

  expect(draft.unknownIsins[0]!.currency).toBe(EUR);
});
