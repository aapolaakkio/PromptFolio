import { test, expect } from "bun:test";

const FORBIDDEN = /from\s+['"](.*\/(server|web)\/|bun:sqlite|drizzle-orm|better-auth)/;

test("src/core imports nothing from server, web, or a database", async () => {
  const offenders: string[] = [];
  for await (const path of new Bun.Glob("src/core/**/*.ts").scan(".")) {
    const source = await Bun.file(path).text();
    for (const [index, line] of source.split("\n").entries()) {
      if (FORBIDDEN.test(line)) offenders.push(`${path}:${index + 1}: ${line.trim()}`);
    }
  }
  expect(offenders).toEqual([]);
});
