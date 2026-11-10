import { importNordnet } from "./harness/flows.ts";
import { expect, test } from "./harness/test.ts";

const NOTE = "A calm week for your portfolio. Nothing needs your attention right now.";

test("the Dashboard shows the weekly note Claude wrote", async ({ page, user: _user, claude }) => {
  claude.replySummary(NOTE);
  await page.goto("/");

  const section = page.getByRole("region", { name: "This week" });
  await expect(section.getByText(NOTE)).toBeVisible();
  await expect(section.getByText("Summary text unavailable")).toHaveCount(0);
});

test("a second visit in the same week reads the stored note and makes no call", async ({
  page,
  user: _user,
  claude,
}) => {
  claude.replySummary(NOTE);
  await page.goto("/");
  await expect(page.getByText(NOTE)).toBeVisible();
  expect(claude.requests).toHaveLength(1);

  await page.goto("/");
  await expect(page.getByText(NOTE)).toBeVisible();
  expect(claude.requests).toHaveLength(1);
});

test("a note with a number that is not in the facts is refused and the facts are shown instead", async ({
  page,
  user: _user,
  claude,
}) => {
  // Three attempts, each refused: the model is sent the reason and asked again.
  for (const _attempt of [1, 2, 3]) {
    claude.replySummary("Your portfolio grew by 987654.32 euros this week.");
  }
  await page.goto("/");

  const section = page.getByRole("region", { name: "This week" });
  await expect(section.getByText(/Summary text unavailable — showing the facts/)).toBeVisible();
  await expect(section.getByText("987654.32")).toHaveCount(0);
  expect(claude.requests).toHaveLength(3);
});

test("the facts list stays in view next to a refused note after an import", async ({
  page,
  user: _user,
  claude,
}) => {
  await importNordnet(page, claude);
  for (const _attempt of [1, 2, 3]) claude.replySummary("Up 555555.55 euros.");
  await page.goto("/");

  const section = page.getByRole("region", { name: "This week" });
  await expect(section.getByText(/Summary text unavailable/)).toBeVisible();
  await expect(section.getByText(/^Portfolio value €/)).toBeVisible();
});
