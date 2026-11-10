import { expect, test } from "vitest";

import { signOutAndLeave } from "./root.tsx";

test("signing out forgets the assistant panel, then goes to the login page", async () => {
  const order: string[] = [];
  await signOutAndLeave(
    async () => {
      order.push("signed out");
    },
    (path) => order.push(`go ${path}`),
    () => order.push("forgot the panel"),
  );
  expect(order).toEqual(["signed out", "forgot the panel", "go /login"]);
});

test("a sign-out that fails stays on the page", async () => {
  const went: string[] = [];
  await expect(
    signOutAndLeave(
      async () => {
        throw new Error("offline");
      },
      (path) => went.push(path),
      () => went.push("forgot"),
    ),
  ).rejects.toThrow("offline");
  expect(went).toEqual([]);
});
