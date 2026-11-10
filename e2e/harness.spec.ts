import { expect, test } from "./harness/test.ts";

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
