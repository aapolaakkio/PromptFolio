import { test, expect } from "vitest";
import { VERSION } from "./version.ts";

test("exposes a semver version string", () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
