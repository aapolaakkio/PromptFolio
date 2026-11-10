import { expect, test } from "./harness/test.ts";

test("a chat question reaches the scripted Claude and its answer is shown", async ({
  page,
  user: _user,
  claude,
}) => {
  claude.reply("Hi from the fake.");

  await page.goto("/chat");
  await page.getByLabel("Question").fill("Hello");
  await page.getByRole("button", { name: "Ask" }).click();

  await expect(page.getByText("Hi from the fake.")).toBeVisible();
  expect(claude.requests[0]?.system).toContain("Finnish");
  expect(claude.requests[0]?.lastUser).toContain("Hello");
});
