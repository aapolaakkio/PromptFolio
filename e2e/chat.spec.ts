import type { Page } from "@playwright/test";

import { expect, test } from "./harness/test.ts";
import type { Claude } from "./harness/claude.ts";
import {
  createBankAccount,
  importNordnet,
  importNordnetOwnInstrument,
  importOpCsv,
  opCsv,
  opRow,
} from "./harness/flows.ts";

const PAYEE = "ZZ TESTIKAUPPA";
const STORE_ROW = opRow("2025-09-02", "-23,50", "PKORTTIMAKSU", PAYEE, "2025090200000001");
const SALARY_ROW = opRow("2025-09-01", "1000,00", "PALKKA", "ESIMERKKI OYJ", "2025090100000009");

const ask = async (page: Page, question: string): Promise<void> => {
  await page.getByLabel("Question").fill(question);
  await page.getByRole("button", { name: "Ask" }).click();
};

/** A bank account whose one payee no rule knows: it shows as Other on Spending. */
const importUncategorisedPayee = async (page: Page, claude: Claude): Promise<void> => {
  await createBankAccount(page, "OP Current");
  const file = opCsv(SALARY_ROW, STORE_ROW);
  await importOpCsv(page, claude, { account: "OP Current", file, classifier: { rules: [] } });
};

const showSeptember = async (page: Page): Promise<void> => {
  await page.goto("/spending");
  await page.getByLabel("From").fill("2025-09-01");
  await page.getByLabel("To").fill("2025-09-30");
};

const ruleProposal = {
  rules: [{ pattern: PAYEE, category: "leisure" }],
};

test("an answer streams into the transcript with the question above it", async ({
  page,
  user: _user,
  claude,
}) => {
  claude.reply("Your portfolio is empty so far.");
  await page.goto("/chat");
  await ask(page, "What do I own?");

  await expect(page.getByText("Your portfolio is empty so far.")).toBeVisible();
  await expect(page.getByLabel("Question")).toHaveValue("");
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: /^What do I own\?$/ })
      .filter({ hasNot: page.getByRole("button") }),
  ).toBeVisible();
});

test("a tool call shows what was fetched, then the answer", async ({
  page,
  user: _user,
  claude,
}) => {
  claude.replyWithTool("get_holdings", {});
  const release = claude.replyHeld("You hold nothing yet.");
  await page.goto("/chat");
  await ask(page, "What do I hold?");

  await expect(page.getByText("Fetched: holdings")).toBeVisible();
  release();
  await expect(page.getByText("You hold nothing yet.")).toBeVisible();
  await expect(page.getByText("Fetched: holdings")).toBeHidden();
  expect(claude.requests).toHaveLength(2);
  expect(claude.requests[0]?.lastUser).toContain("What do I hold?");
  // The harness JSON-stringifies non-text blocks: the second request carries the tool result.
  expect(claude.requests[1]?.lastUser).toContain("tool_result");
});

test("Confirm on a proposal card saves the rule and Spending shows it", async ({
  page,
  user: _user,
  claude,
}) => {
  await importUncategorisedPayee(page, claude);
  claude.replyWithTool("propose_spending_rules", ruleProposal);
  claude.reply("Here is the rule I suggest.");
  await page.goto("/chat");
  await ask(page, `Put ${PAYEE} under leisure`);

  await expect(page.getByText("Save a spending rule")).toBeVisible();
  await expect(page.getByText(PAYEE, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved.");

  await showSeptember(page);
  await expect(page.getByRole("row", { name: /^Leisure 1 / })).toContainText("-€23.50");
  await expect(page.getByRole("row", { name: /^Other / })).toHaveCount(0);
});

test("Dismiss on a proposal card saves nothing", async ({ page, user: _user, claude }) => {
  await importUncategorisedPayee(page, claude);
  claude.replyWithTool("propose_spending_rules", ruleProposal);
  claude.reply("Here is the rule I suggest.");
  await page.goto("/chat");
  await ask(page, `Put ${PAYEE} under leisure`);

  await expect(page.getByText("Save a spending rule")).toBeVisible();
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByRole("status")).toHaveText("Dismissed. Nothing was saved.");

  await showSeptember(page);
  await expect(page.getByRole("row", { name: /^Other 1 / })).toContainText("-€23.50");
  await expect(page.getByRole("row", { name: /^Leisure / })).toHaveCount(0);
});

test("a deletion card carries the warning text and a Delete button, and deleting removes the rule", async ({
  page,
  user: _user,
  claude,
}) => {
  await importUncategorisedPayee(page, claude);
  await showSeptember(page);
  await page
    .getByRole("combobox", { name: `Categorise ${PAYEE}` })
    .selectOption({ label: "Leisure" });
  await expect(page.getByRole("row", { name: /^Leisure 1 / })).toBeVisible();

  claude.replyWithTool("propose_delete_spending_rule", { pattern: PAYEE });
  claude.reply("Here is the deletion.");
  await page.goto("/chat");
  await ask(page, `Delete the rule for ${PAYEE}`);

  // Only a CSS class styles the card red; the warning is told apart by its text and its own button.
  await expect(page.getByText("⚠ Delete")).toBeVisible();
  await expect(page.getByText("Delete a spending rule")).toBeVisible();
  await expect(page.getByText("This removes data. This cannot be undone.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm" })).toHaveCount(0);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved.");

  await showSeptember(page);
  await expect(page.getByRole("row", { name: /^Other 1 / })).toContainText("-€23.50");
});

test("a chart reply draws the chart with its title and legend entry", async ({
  page,
  user: _user,
  claude,
}) => {
  await importNordnet(page, claude);
  claude.replyWithTool("show_chart", {
    title: "Portfolio value over time",
    yUnit: "EUR",
    series: [{ source: "value-series", range: "max", label: "Portfolio value" }],
  });
  claude.reply("Here is the chart.");
  await page.goto("/chat");
  await ask(page, "Chart my portfolio");

  await expect(page.getByText("Portfolio value over time", { exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Legend" })).toContainText("Portfolio value");
  await expect(page.getByRole("img", { name: "Portfolio value over time" })).toBeVisible();
});

test("the docked assistant on Holdings tells Claude which page the owner is on", async ({
  page,
  user: _user,
  claude,
}) => {
  claude.reply("Seen from Holdings.");
  await page.goto("/holdings");
  await page.getByRole("button", { name: "Chat" }).click();
  const dock = page.getByRole("complementary", { name: "Assistant" });
  await dock.getByLabel("Question").fill("Where am I?");
  await dock.getByRole("button", { name: "Ask" }).click();

  await expect(dock.getByText("Seen from Holdings.")).toBeVisible();
  expect(claude.requests[0]?.system).toContain("The owner is on the Holdings page.");
});

test("conversations are listed, reopened and deleted", async ({ page, user: _user, claude }) => {
  claude.reply("First answer.");
  claude.reply("Second answer.");
  await page.goto("/chat");
  await ask(page, "First topic");
  await expect(page.getByText("First answer.")).toBeVisible();
  await page.getByRole("button", { name: "New conversation" }).click();
  await ask(page, "Second topic");
  await expect(page.getByText("Second answer.")).toBeVisible();

  const first = page.getByRole("button", { name: "First topic", exact: true });
  const second = page.getByRole("button", { name: "Second topic", exact: true });
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();

  await first.click();
  await expect(page.getByText("First answer.")).toBeVisible();
  await expect(page.getByText("Second answer.")).toHaveCount(0);

  await page.getByRole("button", { name: "Delete conversation Second topic" }).click();
  await expect(second).toHaveCount(0);
  await expect(first).toBeVisible();
  await page.reload();
  await expect(first).toBeVisible();
  await expect(second).toHaveCount(0);
});

test("a Claude failure shows an error and the composer asks again", async ({
  page,
  user: _user,
  claude,
}) => {
  claude.replyError(500);
  claude.reply("Back again.");
  await page.goto("/chat");
  await ask(page, "First try");

  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("alert")).not.toBeEmpty();

  await ask(page, "Second try");
  await expect(page.getByText("Back again.")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

/** The id the assistant read from get_instruments for one ISIN: ids are the database's, so the test learns it the way the assistant does. */
const idOfIsin = (toolResult: string, isin: string): number => {
  const match = new RegExp(`"id\\\\?":(\\d+),[^}]*?${isin}`).exec(toolResult);
  if (match?.[1] === undefined) throw new Error(`no instrument id for ${isin} in ${toolResult}`);
  return Number(match[1]);
};

test("a price the assistant proposes is saved on Confirm and Holdings shows the new value", async ({
  page,
  app,
  user: _user,
  claude,
}) => {
  const isin = await importNordnetOwnInstrument(page, app, claude);
  claude.replyWithTool("get_instruments", {});
  claude.reply("Here are your instruments.");
  await page.goto("/chat");
  await ask(page, "Which instruments do I have?");
  await expect(page.getByText("Here are your instruments.")).toBeVisible();
  const instrumentId = idOfIsin(
    claude.requests.findLast((seen) => seen.lastUser.includes("tool_result"))?.lastUser ?? "",
    isin,
  );

  claude.replyWithTool("find_price", { instrumentId, date: "2026-11-02", windowDays: 365 });
  claude.reply("I looked for a price near that day.");
  await ask(page, "Is there a price for 2026-11-02?");
  await expect(page.getByText("I looked for a price near that day.")).toBeVisible();

  claude.replyWithTool("propose_record_price", {
    instrumentId,
    date: "2026-11-02",
    price: "40.00",
    source: "own trade on 2026-11-02",
  });
  claude.reply("Here is the price I suggest.");
  await ask(page, "Set the price on 2026-11-02 to 40.00 euros");

  await expect(page.getByText("Record a manual price")).toBeVisible();
  await expect(page.getByText("Shared by everyone in the household")).toBeVisible();
  await expect(page.getByText("own trade on 2026-11-02", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved.");

  await page.goto("/holdings");
  const row = page.getByRole("row", { name: /WisdomTree/ });
  await expect(row).toContainText("€80.00");
});

const SEARCH_SOURCE = { title: "Acme Oyj offer document", url: "https://example.com/acme-offer" };

const webSearchSwitch = (page: Page) =>
  page.getByRole("switch", { name: "Web search", exact: true });

test("web search is off by default, and the request then offers no search tool", async ({
  page,
  user: _user,
  claude,
}) => {
  claude.reply("No search needed.");
  await page.goto("/chat");
  await expect(page.getByText("Ask about your own figures, for example:")).toBeVisible();
  await expect(webSearchSwitch(page)).not.toBeChecked();
  await ask(page, "What do I own?");

  await expect(page.getByText("No search needed.")).toBeVisible();
  expect(claude.requests[0]?.tools.map((tool) => tool.name)).not.toContain("web_search");
});

test("turning web search on is remembered, and a search shows its query and sources", async ({
  page,
  user: _user,
  claude,
}) => {
  await page.goto("/chat");
  await webSearchSwitch(page).check();
  await page.reload();
  await expect(webSearchSwitch(page)).toBeChecked();

  claude.replyWithSearch("Acme Oyj tender offer price", [SEARCH_SOURCE], "The offer was 4.20 EUR.");
  await ask(page, "What was the Acme tender offer price?");

  await expect(page.getByText("The offer was 4.20 EUR.")).toBeVisible();
  await expect(
    page.getByText("Searched the web: Acme Oyj tender offer price", { exact: true }),
  ).toBeVisible();
  const link = page.getByRole("link", { name: SEARCH_SOURCE.title, exact: true });
  await expect(link).toHaveAttribute("href", SEARCH_SOURCE.url);
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(claude.requests[0]?.tools).toContainEqual({
    name: "web_search",
    type: "web_search_20260318",
    max_uses: 3,
  });

  await page.reload();
  await expect(
    page.getByText("Searched the web: Acme Oyj tender offer price", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: SEARCH_SOURCE.title, exact: true })).toBeVisible();
});

test("a search whose words held an account number carries a warning", async ({
  page,
  user: _user,
  claude,
}) => {
  await page.goto("/chat");
  await webSearchSwitch(page).check();
  claude.replyWithSearch("FI21 1234 5600 0007 85 balance", [], "I could not find that.");
  await ask(page, "Look this up");

  await expect(page.getByText("I could not find that.")).toBeVisible();
  await expect(
    page.getByText("Warning: this search included personal data.", { exact: true }),
  ).toBeVisible();
});
