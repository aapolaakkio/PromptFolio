import { expect, test } from "./harness/test.ts";

const PAGES = [
  "Dashboard",
  "Holdings",
  "Reconcile",
  "Cash",
  "Debts",
  "Spending",
  "Rebalance",
  "Forecast",
  "Tax",
  "Imports",
] as const;

test("every nav link opens its heading with no console error and no failed request", async ({
  page,
  user: _user,
  claude: _claude,
}) => {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => problems.push(`failed: ${request.url()}`));
  page.on("response", (response) => {
    if (response.status() >= 400) problems.push(`${response.status()}: ${response.url()}`);
  });

  await page.goto("/");
  for (const name of PAGES) {
    await page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
    await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  }
  await page.waitForLoadState("networkidle");

  expect(problems).toEqual([]);
});

test("the theme choice survives a reload", async ({ page, user: _user }) => {
  await page.goto("/holdings");
  await page.getByRole("button", { name: "Theme: System" }).click();
  await page.getByRole("button", { name: "Theme: Light" }).click();
  await expect(page.getByRole("button", { name: "Theme: Dark" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.reload();

  await expect(page.getByRole("button", { name: "Theme: Dark" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
