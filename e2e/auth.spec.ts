import { expect, test } from "./harness/test.ts";

const PASSWORD = "correct horse battery staple";

test("the first-run form creates the owner and lands on the Dashboard", async ({
  page,
  freshApp,
  freshClaude: _claude,
}) => {
  await page.goto(`${freshApp.baseURL}/login`);
  await page.getByLabel("Name").fill("First Owner");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(`${freshApp.baseURL}/`);
  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
});

test("mismatched passwords are refused and no account is made", async ({ page, freshApp }) => {
  await page.goto(`${freshApp.baseURL}/login`);
  await page.getByLabel("Name").fill("First Owner");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(`${PASSWORD} again`);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByRole("alert")).toHaveText("Passwords do not match");
  await expect(page).toHaveURL(`${freshApp.baseURL}/login`);
  // Still the first-run form after a reload: nothing was created.
  await page.reload();
  await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();
});

test("logged out, /holdings redirects to /login", async ({ page, app }) => {
  await page.goto("/holdings");

  await expect(page).toHaveURL(`${app.baseURL}/login`);
});

test("a wrong password shows an error and stays on /login", async ({ page, user }) => {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(`${user.password} wrong`);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("alert")).toHaveText("Sign-in failed");
  await expect(page).toHaveURL(/\/login$/);
});

test("the right password signs in and lands on the Dashboard", async ({
  page,
  user,
  claude: _claude,
}) => {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
});

test("sign out returns to /login and locks the pages again", async ({ page, user: _user }) => {
  await page.goto("/holdings");
  await page.getByRole("button", { name: "Sign out" }).click();

  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/holdings");
  await expect(page).toHaveURL(/\/login$/);
});
