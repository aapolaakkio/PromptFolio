import { expect, test } from "vitest";

import { parseCurrency } from "../../core/money.ts";
import { readText } from "../files.ts";
import {
  IDENTITY_WINDOW_CHARS,
  judgePageRead,
  PageRecipeSchema,
  runPageRecipe,
  type PageExpect,
  type PageRecipe,
} from "./page-recipe.ts";

const fixture = (name: string) => readText(`${import.meta.dirname}/fixtures/${name}`);

const EUR = parseCurrency("EUR");
const SEK = parseCurrency("SEK");
const TODAY = "2026-08-27";

const NORDNET: PageRecipe = {
  kind: "page",
  pattern:
    String.raw`\\"currency\\":\\"(?<currency>[A-Z]{3})\\"\}\},\\"navInfo\\":\{[^}]*?\\"latestNav\\":` +
    String.raw`\{\\"date\\":\\"(?<date>\d{4}-\d{2}-\d{2})\\",\\"value\\":(?<price>[\d.]+)\}`,
  dateFormat: "yyyy-mm-dd",
  money: { decimal: ".", thousands: "", negative: "leading", twoColumn: false },
  currency: null,
};

const OP: PageRecipe = {
  kind: "page",
  pattern: String.raw`<dt>Osuuden arvo \((?<date>\d{2}\.\d{2}\.)\)</dt>\s*<dd>(?<price>[\d\s,]+?)\s(?<currency>[A-Z]{3})</dd>`,
  dateFormat: "dd.mm.",
  money: { decimal: ",", thousands: " ", negative: "leading", twoColumn: false },
  currency: null,
};

const SUOMI_ISIN = "SE0005993102";
const expectEur = (over: Partial<PageExpect> = {}): PageExpect => ({
  identity: SUOMI_ISIN,
  currency: EUR,
  referenceMinor: null,
  today: TODAY,
  ...over,
});

test("reads the Nordnet NAV next to its ISIN", async () => {
  const html = await fixture("nordnet-fund-suomi.html");
  const read = runPageRecipe(html, NORDNET, SUOMI_ISIN, TODAY);
  expect(read.matches).toBe(1);
  expect(read.price).toEqual({ date: "2026-08-25", closeMinor: 36525, currency: EUR });
  expect(read.identityNear).toBe(true);
  expect(judgePageRead(read, expectEur()).passed).toBe(true);
});

test("reads a SEK NAV as SEK", async () => {
  const html = await fixture("nordnet-fund-sverige.html");
  const read = runPageRecipe(html, NORDNET, "SE0002756973", TODAY);
  expect(read.price).toEqual({ date: "2026-08-25", closeMinor: 85868, currency: SEK });
  expect(judgePageRead(read, expectEur({ identity: "SE0002756973", currency: SEK })).passed).toBe(
    true,
  );
  expect(judgePageRead(read, expectEur({ identity: "SE0002756973" })).passed).toBe(false);
});

test("reads OP's NAV with a yearless date", async () => {
  const html = await fixture("op-maailma-indeksi.html");
  const read = runPageRecipe(html, OP, "OP-Maailma Indeksi", TODAY);
  expect(read.price).toEqual({ date: "2026-08-26", closeMinor: 28360, currency: EUR });
  expect(read.identityNear).toBe(false);
  const byUrlName = runPageRecipe(html, OP, "op-maailma-indeksi", TODAY);
  expect(byUrlName.identityNear).toBe(true);
  expect(judgePageRead(byUrlName, expectEur({ identity: "op-maailma-indeksi" })).passed).toBe(true);
});

test("a yearless 31.12. read on 2 January is last year", async () => {
  const html = (await fixture("op-maailma-indeksi.html")).replace("26.08.", "31.12.");
  const read = runPageRecipe(html, OP, "op-maailma-indeksi", "2027-01-02");
  expect(read.price?.date).toBe("2026-12-31");
});

test("1 234,56 with a non-breaking space parses to 123456 minor", () => {
  const html = "<p>ISIN X1</p><b>NAV 1 234,56 EUR 2026-08-26</b>";
  const recipe: PageRecipe = {
    kind: "page",
    pattern: String.raw`NAV (?<price>[\d\s,]+?) (?<currency>[A-Z]{3}) (?<date>\d{4}-\d{2}-\d{2})`,
    dateFormat: "yyyy-mm-dd",
    money: { decimal: ",", thousands: " ", negative: "leading", twoColumn: false },
    currency: null,
  };
  expect(runPageRecipe(html, recipe, "X1", TODAY).price?.closeMinor).toBe(123456);
});

test("a fixed currency is used when the pattern names none", async () => {
  const html = await fixture("op-maailma-indeksi.html");
  const recipe: PageRecipe = {
    ...OP,
    pattern: String.raw`<dt>Osuuden arvo \((?<date>\d{2}\.\d{2}\.)\)</dt>\s*<dd>(?<price>[\d\s,]+?)\s[A-Z]{3}</dd>`,
    currency: "EUR",
  };
  expect(runPageRecipe(html, recipe, "op-maailma-indeksi", TODAY).price?.currency).toBe(EUR);
});

test("a list page with two matching NAVs is refused", async () => {
  const one = await fixture("nordnet-fund-suomi.html");
  const two = await fixture("nordnet-fund-sverige.html");
  const read = runPageRecipe(one + two, NORDNET, SUOMI_ISIN, TODAY);
  expect(read.matches).toBe(2);
  const judged = judgePageRead(read, expectEur());
  expect(judged.passed).toBe(false);
  expect(judged.score).toBe(0);
  expect(judged.feedback).toContain("useampi");
});

test("a match far from the ISIN is refused", async () => {
  const html = await fixture("nordnet-fund-suomi.html");
  const padded = html.replace(SUOMI_ISIN, `${SUOMI_ISIN}${"x".repeat(IDENTITY_WINDOW_CHARS + 1)}`);
  const read = runPageRecipe(padded, NORDNET, SUOMI_ISIN, TODAY);
  expect(read.identityNear).toBe(false);
  const judged = judgePageRead(read, expectEur());
  expect(judged.passed).toBe(false);
  expect(judged.feedback).toContain("SE0005993102");
});

test("wrong currency, a stale date, and a price 11x the reference are each refused", async () => {
  const html = await fixture("nordnet-fund-suomi.html");
  const read = runPageRecipe(html, NORDNET, SUOMI_ISIN, TODAY);
  expect(judgePageRead(read, expectEur({ currency: SEK })).feedback).toContain("valuutta");
  expect(judgePageRead(read, expectEur({ today: "2026-09-10" })).feedback).toContain("vanha");
  expect(judgePageRead(read, expectEur({ today: "2026-08-24" })).feedback).toContain("tulevaisuu");
  expect(judgePageRead(read, expectEur({ referenceMinor: 3320 })).feedback).toContain("kohtuuton");
  expect(judgePageRead(read, expectEur({ referenceMinor: 36000 })).passed).toBe(true);
});

test("no match scores 0 and says so", () => {
  const read = runPageRecipe("<p>nothing</p>", NORDNET, SUOMI_ISIN, TODAY);
  expect(read).toEqual({ matches: 0, price: null, identityNear: false });
  expect(judgePageRead(read, expectEur()).passed).toBe(false);
});

test("an unreadable price gives no price", () => {
  const html = "<p>NAV abc EUR 2026-08-26</p>";
  const recipe: PageRecipe = {
    kind: "page",
    pattern: String.raw`NAV (?<price>\w+) (?<currency>[A-Z]{3}) (?<date>\d{4}-\d{2}-\d{2})`,
    dateFormat: "yyyy-mm-dd",
    money: { decimal: ".", thousands: "", negative: "leading", twoColumn: false },
    currency: null,
  };
  const read = runPageRecipe(html, recipe, "NAV", TODAY);
  expect(read.matches).toBe(1);
  expect(read.price).toBeNull();
  expect(judgePageRead(read, expectEur({ identity: "NAV" })).score).toBe(0);
});

test("a backtracking pattern is rejected by the schema", () => {
  const bad = { ...NORDNET, pattern: String.raw`(?<price>(\d+)+)(?<date>x)` };
  expect(PageRecipeSchema.safeParse(bad).success).toBe(false);
});

test("a pattern missing the price or date group is rejected", () => {
  const noDate = { ...NORDNET, pattern: String.raw`(?<price>\d+)` };
  expect(PageRecipeSchema.safeParse(noDate).success).toBe(false);
  expect(PageRecipeSchema.safeParse(NORDNET).success).toBe(true);
});
