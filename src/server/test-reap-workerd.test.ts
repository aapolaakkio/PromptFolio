import { expect, test } from "vitest";

import { orphanedWorkerd } from "./test-reap-workerd.ts";

const NM = "/repo/node_modules";

test("only this repo's workerd whose parent is init is an orphan", () => {
  const ps = [
    `  101     1 ${NM}/.pnpm/@cloudflare+workerd-darwin-arm64@1/node_modules/@cloudflare/workerd serve`,
    `  102  5000 ${NM}/.pnpm/@cloudflare+workerd-darwin-arm64@1/node_modules/@cloudflare/workerd serve`,
    `  103     1 /other/node_modules/@cloudflare/workerd serve`,
    `  104     1 ${NM}/.bin/vite`,
    "",
  ].join("\n");
  expect(orphanedWorkerd(ps, NM)).toEqual([101]);
});
