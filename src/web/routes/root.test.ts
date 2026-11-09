import { expect, test } from "vitest";

import { signOutAndLeave } from "./root.tsx";

test("signing out goes to the login page, after the session is ended", async () => {
  const order: string[] = [];
  await signOutAndLeave(
    async () => {
      order.push("signed out");
    },
    (path) => order.push(`go ${path}`),
  );
  expect(order).toEqual(["signed out", "go /login"]);
});

test("a sign-out that fails stays on the page", async () => {
  const went: string[] = [];
  await expect(
    signOutAndLeave(
      async () => {
        throw new Error("offline");
      },
      (path) => went.push(path),
    ),
  ).rejects.toThrow("offline");
  expect(went).toEqual([]);
});
