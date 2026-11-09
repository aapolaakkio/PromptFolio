import { expect, test } from "vitest";
import { firstThenRest } from "./preview-order.ts";

test("the first file finishes before the others start, and order is kept", async () => {
  const started: string[] = [];
  let firstDone = false;
  const seen: boolean[] = [];
  const results = await firstThenRest(["jan", "feb", "mar"], async (name) => {
    started.push(name);
    seen.push(firstDone);
    await Promise.resolve();
    if (name === "jan") firstDone = true;
    return name.toUpperCase();
  });
  expect(results).toEqual(["JAN", "FEB", "MAR"]);
  expect(seen).toEqual([false, true, true]);
});

test("no files, no calls", async () => {
  expect(await firstThenRest([], async () => 1)).toEqual([]);
});
