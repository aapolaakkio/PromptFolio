import { readFileSync } from "node:fs";

import { importNordnet, NORDNET_FIXTURE, nordnetFile } from "./harness/flows.ts";
import { expect, test } from "./harness/test.ts";

const FIELDS = {
  id: 0,
  date: 1,
  type: 5,
  name: 6,
  isin: 7,
  quantity: 8,
  price: 9,
  sum: 13,
} as const;
const SUOMI = ["Nordnet Suomi Indeksi", "SE0005993102"] as const;
const WISDOMTREE = ["WisdomTree Europe Defence UCITS ETF - EUR Acc", "IE0002Y8CX98"] as const;

type Trade = {
  readonly id: string;
  readonly date: string;
  readonly type: "OSTO" | "MYYNTI";
  readonly instrument: readonly [string, string];
  readonly quantity: number;
  readonly price: number;
};

const decimal = (value: number): string => value.toFixed(2).replace(".", ",");

/** One more sample row: the sample's own buy or sale row with the trade fields replaced (the broker's columns stay as they are). */
const tradeRow = (template: string, trade: Trade): string => {
  const cells = template.split("\t");
  const amount = trade.quantity * trade.price;
  const set = (at: number, value: string) => cells.splice(at, 1, value);
  set(FIELDS.id, trade.id);
  for (const at of [FIELDS.date, 2, 3]) set(at, trade.date);
  set(FIELDS.type, trade.type);
  set(FIELDS.name, trade.instrument[0]);
  set(FIELDS.isin, trade.instrument[1]);
  set(FIELDS.quantity, String(trade.quantity));
  set(FIELDS.price, decimal(trade.price));
  set(FIELDS.sum, decimal(trade.type === "OSTO" ? -amount : amount));
  // Unique confirmation numbers, or the rows read as duplicates of the sample's.
  set(24, `91000${trade.id}`);
  set(25, `91000${trade.id}`);
  return cells.join("\t");
};

/**
 * The sample sells 5 Suomi units it never bought and swaps HANetf units it never held (rows 5010-5013), and the cost basis refuses both:
 * the Tax page fails to load a year with either. So this drops the swap rows and adds the missing buy and more sales:
 * Suomi: buy 10 at 10.00 (2024-03-01); sell 2 at 150.00 (2024-11-01); [sample: sell 5 at 100.00 on 2025-02-01]; sell 3 at 200.00 (2025-06-01).
 * WisdomTree: [sample: buy 2 at 34.00 on 2025-01-10]; sell 1 at 20.00 (2025-07-01).
 */
const sampleWithSales = () => {
  const text = readFileSync(NORDNET_FIXTURE).toString("utf16le");
  const separator = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(separator);
  const buyTemplate = lines.find((line) => line.startsWith("5001\t")) ?? "";
  const saleTemplate = lines.find((line) => line.startsWith("5002\t")) ?? "";
  const extra = [
    tradeRow(buyTemplate, {
      id: "5101",
      date: "2024-03-01",
      type: "OSTO",
      instrument: SUOMI,
      quantity: 10,
      price: 10,
    }),
    tradeRow(saleTemplate, {
      id: "5102",
      date: "2024-11-01",
      type: "MYYNTI",
      instrument: SUOMI,
      quantity: 2,
      price: 150,
    }),
    tradeRow(saleTemplate, {
      id: "5103",
      date: "2025-06-01",
      type: "MYYNTI",
      instrument: SUOMI,
      quantity: 3,
      price: 200,
    }),
    tradeRow(saleTemplate, {
      id: "5104",
      date: "2025-07-01",
      type: "MYYNTI",
      instrument: WISDOMTREE,
      quantity: 1,
      price: 20,
    }),
  ];
  // The swap rows are 5010 to 5013; the rest of the sample stays.
  const body = lines.filter((line) => line !== "" && !/^50(1[0-3])\t/.test(line));
  return nordnetFile(Buffer.from([...body, ...extra].join(separator) + separator, "utf16le"));
};

const importWithSales = (
  page: Parameters<typeof importNordnet>[0],
  claude: Parameters<typeof importNordnet>[1],
) => importNordnet(page, claude, { file: sampleWithSales(), transactions: 13, swapRows: false });

test("a tax year shows each sale under the method that gave the lower gain, with the other method's figure beside it", async ({
  page,
  user: _user,
  claude,
}) => {
  await importWithSales(page, claude);
  await page.goto("/tax");
  // The latest year comes first.
  const year = page.getByRole("combobox", { name: "Tax year" });
  await expect(year).toHaveValue("2025");

  // Held under ten years, so the deemed cost is 20 % of the sale price. Gain = sale - cost.
  // Suomi 5 units: sold 500.00; actual cost 5 x 10.00 = 50.00 (gain 450.00), deemed 100.00 (gain 400.00): deemed is lower.
  const first = page.getByRole("row", { name: /^01\/02\/2025 Nordnet Suomi/ });
  await expect(first).toContainText("€500.00");
  await expect(first).toContainText("deemed cost 20 %");
  await expect(first).toContainText("€100.00");
  await expect(first).toContainText("€400.00");
  await expect(first).toContainText("with actual cost €450.00");
  // 3 units at 200.00 = 600.00: actual cost 30.00 (gain 570.00), deemed 120.00 (gain 480.00).
  const second = page.getByRole("row", { name: /^01\/06\/2025 Nordnet Suomi/ });
  await expect(second).toContainText("€600.00");
  await expect(second).toContainText("€480.00");
  await expect(second).toContainText("with actual cost €570.00");
  // WisdomTree sold for 20.00 against 34.00 paid: a loss under actual cost, and a loss never takes the deemed method.
  const loss = page.getByRole("row", { name: /^01\/07\/2025 WisdomTree/ });
  await expect(loss).toContainText("actual cost");
  await expect(loss).toContainText("-€14.00");
  await expect(loss).toContainText("with deemed cost €16.00");

  // Sales total 1,120.00, over the 1,000 limit: gains 880.00, loss 14.00.
  await expect(page.getByText("Gains €880.00, losses €14.00, taxable €866.00.")).toBeVisible();
});

test("switching the tax year shows that year's sales, small ones tax-free", async ({
  page,
  user: _user,
  claude,
}) => {
  await importWithSales(page, claude);
  await page.goto("/tax");
  const year = page.getByRole("combobox", { name: "Tax year" });
  await expect(page.getByText(/^Gains €880\.00/)).toBeVisible();
  await expect(year.getByRole("option")).toHaveText(["2025", "2024"]);

  await year.selectOption("2024");
  // One sale: 2 units at 150.00 = 300.00, under the 1,000 limit.
  const sale = page.getByRole("row", { name: /^01\/11\/2024 Nordnet Suomi/ });
  await expect(sale).toContainText("€300.00");
  await expect(sale).toContainText("deemed cost 20 %");
  await expect(sale).toContainText("€240.00");
  await expect(sale).toContainText("with actual cost €280.00");
  await expect(page.getByText(/^Total sales for the year €300\.00 — at most €1,000/)).toBeVisible();
  await expect(page.getByText(/^Gains /)).toHaveCount(0);
  await expect(page.getByRole("row", { name: /^01\/02\/2025/ })).toHaveCount(0);

  await year.selectOption("2025");
  await expect(page.getByText("Gains €880.00, losses €14.00, taxable €866.00.")).toBeVisible();
  await expect(page.getByRole("row", { name: /^01\/11\/2024/ })).toHaveCount(0);
});

test.fixme("the sample alone, which sells units it never bought, makes the Tax page say why it has no report", async ({
  page,
  user: _user,
  claude,
}) => {
  // App: with the sample's unbought units (and its HANetf swap rows) getTaxYear fails with "Cannot dispose 5.000000 units ... only 0.000000 held" and the page renders nothing for the failed query, only the year picker.
  await importNordnet(page, claude);
  await page.goto("/tax");
  await expect(page.getByRole("combobox", { name: "Tax year" })).toBeVisible();
  await expect(page.getByRole("alert")).toBeVisible();
});
