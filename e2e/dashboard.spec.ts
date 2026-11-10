import { importNordnet } from "./harness/flows.ts";
import { expect, test } from "./harness/test.ts";

test("a new user's dashboard explains that there are no investments yet", async ({
  page,
  user: _user,
  claude: _claude,
}) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No investments yet" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Value over time" })).toHaveCount(0);
});

test("after an import the dashboard shows the value, the allocation and the value chart", async ({
  page,
  user: _user,
  claude,
}) => {
  await importNordnet(page, claude);
  await page.goto("/");

  // Cost-valued holdings and the ledger's cash: no figure depends on the day the test runs.
  await expect(page.getByText("€1,875.09", { exact: true })).toBeVisible();
  await expect(page.getByText("investments €140.00 + cash €1,735.09")).toBeVisible();

  await expect(page.getByRole("heading", { name: "Value over time" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Portfolio value" })).toBeVisible();
  // Drawn with data: its legend names the lines, and the ledger gave it invested money and cash.
  await expect(page.getByText("Value (incl. cash)")).toBeVisible();
  await expect(page.getByText("Invested", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "Allocation" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: /Cash\s*€1,735\.09/ })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: /ETFs\s*€140\.00/ })).toBeVisible();
});

test("the range buttons change what the value chart covers", async ({
  page,
  user: _user,
  claude,
}) => {
  await importNordnet(page, claude);
  await page.goto("/");
  const chart = page.getByRole("img", { name: "Portfolio value" });
  const ytd = page.getByRole("button", { name: "YTD" });
  const allTime = page.getByRole("button", { name: "All time" });
  await expect(ytd).toHaveAttribute("aria-pressed", "true");
  // The sample's trades are all in 2025; the year so far starts after them. The legend shows the chart is drawn; no tick in the current year is assumed, as there may be none in the first days of January.
  await expect(page.getByText("Value (incl. cash)")).toBeVisible();
  await expect(chart).not.toContainText("2025");

  await allTime.click();
  await expect(allTime).toHaveAttribute("aria-pressed", "true");
  await expect(ytd).toHaveAttribute("aria-pressed", "false");
  await expect(chart).toContainText("2025");
});
