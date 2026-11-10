import { describe, expect, test } from "vitest";

import { menuStep } from "./menu-keys.ts";

describe("menuStep", () => {
  test("down and up move one entry and wrap", () => {
    expect(menuStep("ArrowDown", 0, 2)).toBe(1);
    expect(menuStep("ArrowDown", 1, 2)).toBe(0);
    expect(menuStep("ArrowUp", 0, 2)).toBe(1);
    expect(menuStep("ArrowUp", 1, 2)).toBe(0);
  });

  test("from the button, down lands on the first entry and up on the last", () => {
    expect(menuStep("ArrowDown", -1, 2)).toBe(0);
    expect(menuStep("ArrowUp", -1, 2)).toBe(1);
  });

  test("Home and End jump to the ends", () => {
    expect(menuStep("Home", 1, 2)).toBe(0);
    expect(menuStep("End", 0, 2)).toBe(1);
  });

  test("leaves every other key alone", () => {
    expect(menuStep("Enter", 0, 2)).toBeNull();
    expect(menuStep("a", 0, 2)).toBeNull();
  });

  test("an empty menu has nowhere to go", () => {
    expect(menuStep("ArrowDown", -1, 0)).toBeNull();
  });
});
