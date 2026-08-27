import { test, expect } from "bun:test";
import { VERSION } from "./version";

test("exposes a semver version string", () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
