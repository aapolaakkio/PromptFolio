import { expect, test, type App } from "./harness/test.ts";

/** Two tests that write the same thing: each has its own user (and, across workers, its own database), so each sees one row. */
for (const run of ["first", "second"]) {
  test(`a debt added by the ${run} test is the only one its user sees`, async ({
    page,
    user: _user,
  }) => {
    await page.goto("/debts");
    await expect(page.getByRole("heading", { name: "Debts", level: 1 })).toBeVisible();

    await page.getByLabel("Name", { exact: true }).fill("Student loan");
    await page.getByRole("button", { name: "Add debt" }).click();

    await expect(page.getByRole("heading", { name: "Student loan", level: 2 })).toHaveCount(1);
  });
}

const MESSAGES_URL = (app: App): string => `${app.upstream.url}/api.anthropic.com/v1/messages`;

/** The Worker's call to Claude with nothing queued, sent straight to the stand-in: no page, no selector to break. */
const askClaudeUnscripted = async (app: App): Promise<Response> => {
  const response = await fetch(MESSAGES_URL(app), {
    method: "POST",
    body: JSON.stringify({
      model: "m",
      system: "s",
      messages: [{ role: "user", content: "Hello" }],
    }),
  });
  await response.text();
  return response;
};

test("an unscripted call to Claude is answered 500 and recorded as unexpected", async ({
  app,
  claude: _claude,
}) => {
  const response = await askClaudeUnscripted(app);

  expect(response.status).toBe(500);
  expect(app.upstream.unexpected).toEqual([expect.stringContaining("no reply queued (Hello)")]);
  // The guard has its own test below; this one hands it a clean slate.
  app.upstream.reset();
});

// Expected to fail, and nothing in the body can: it only sends the call. So the failure is the guard's (upstreamGuard in harness/test.ts); if the guard stops catching, this test passes and Playwright reports that.
test("a call no test scripted fails the test", async ({ app, claude: _claude }) => {
  test.fail();

  await askClaudeUnscripted(app);
});
