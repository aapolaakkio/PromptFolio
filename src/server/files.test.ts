import { describe, expect, test } from "vitest";

import { readBytes, readText } from "./files.ts";

describe("readBytes", () => {
  test("returns exactly the file's own bytes, not the pool around them", async () => {
    // Node reads into a shared arena, so several reads in flight can share one
    // ArrayBuffer. A caller handed the arena would parse whatever else is in it.
    const [first, second] = await Promise.all([
      readBytes("package.json"),
      readBytes("tsconfig.json"),
    ]);

    const asText = new TextDecoder().decode(first!);
    expect(asText).toBe(await readText("package.json"));
    expect(first!.byteLength).toBe(asText.length);
    expect(second!.byteLength).not.toBe(first!.byteLength);
  });
});
