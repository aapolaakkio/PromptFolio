import { randomUUID } from "node:crypto";

import { expect, test } from "./harness/test.ts";

test("user B sees none of user A's accounts, debts or chat", async ({
  page,
  browser,
  app,
  user: userA,
  claude,
}) => {
  claude.reply("Hi from the fake.");
  claude.reply("Hi B from the fake.");

  await page.goto("/imports");
  await page.getByLabel("Account name").fill("Nordnet A-only");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("option", { name: "Nordnet A-only" })).toHaveCount(1);

  await page.goto("/debts");
  await page.getByLabel("Name", { exact: true }).fill("A-only loan");
  await page.getByRole("button", { name: "Add debt" }).click();
  await expect(page.getByRole("heading", { name: "A-only loan", level: 2 })).toBeVisible();

  await page.goto("/chat");
  await page.getByLabel("Question").fill("A-only question");
  await page.getByRole("button", { name: "Ask" }).click();
  await expect(page.getByText("Hi from the fake.")).toBeVisible();
  await expect(page.getByRole("button", { name: "A-only question", exact: true })).toBeVisible();

  const contextB = await browser.newContext({ baseURL: app.baseURL });
  try {
    const signUp = await contextB.request.post("/api/auth/sign-up/email", {
      headers: { origin: app.baseURL },
      data: {
        name: "E2E Other",
        email: `e2e-${randomUUID()}@example.com`,
        password: "correct horse battery staple",
      },
    });
    expect(signUp.ok(), await signUp.text()).toBe(true);
    const sessionEmail = async (request: typeof page.request): Promise<string> => {
      const body: { user: { email: string } } = await (
        await request.get("/api/auth/get-session")
      ).json();
      return body.user.email;
    };
    expect(await sessionEmail(page.request)).toBe(userA.email);
    expect(await sessionEmail(contextB.request)).not.toBe(userA.email);
    const pageB = await contextB.newPage();
    // The harness's networkidle wait covers `page` only; a click before React attaches is lost.
    const open = async (path: string): Promise<void> => {
      await pageB.goto(path);
      await pageB.waitForLoadState("networkidle");
    };

    await open("/imports");
    await expect(pageB.getByText("No accounts yet.")).toBeVisible();
    await expect(pageB.getByRole("option", { name: "Nordnet A-only" })).toHaveCount(0);

    await open("/debts");
    await expect(pageB.getByText("No debts yet.")).toBeVisible();
    await expect(pageB.getByText("A-only loan")).toHaveCount(0);

    await open("/chat");
    await pageB.getByLabel("Question").fill("B-only question");
    await pageB.getByRole("button", { name: "Ask" }).click();
    await expect(pageB.getByText("Hi B from the fake.")).toBeVisible();
    await expect(pageB.getByRole("button", { name: "B-only question", exact: true })).toBeVisible();
    await expect(pageB.getByText("A-only question")).toHaveCount(0);
  } finally {
    await contextB.close();
  }
});
