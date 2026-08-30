import { test, expect } from "vitest";

import { glob, readFile } from "node:fs/promises";

const readFileText = (path: string | URL): Promise<string> => readFile(path, "utf-8");

const FORBIDDEN = /from\s+['"](.*\/(server|web)\/|node:sqlite|drizzle-orm|better-auth)/;

test("src/core imports nothing from server, web, or a database", async () => {
  const offenders: string[] = [];
  for await (const path of glob("src/core/**/*.ts")) {
    const source = await readFileText(path);
    for (const [index, line] of source.split("\n").entries()) {
      if (FORBIDDEN.test(line)) offenders.push(`${path}:${index + 1}: ${line.trim()}`);
    }
  }
  expect(offenders).toEqual([]);
});
