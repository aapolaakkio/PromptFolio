import { defineConfig } from "oxlint";

export default defineConfig({
  ignorePatterns: [".claude/**", "dist/**", "drizzle/**", "tools/oxlint/anti-slop/**"],
  jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
  rules: {
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
    "typescript/no-explicit-any": "error",
    // The database is asynchronous, so a forgotten `await` is a query nobody
    // waits for -- an ownership check that never refuses, a write that never
    // lands. Neither shows up in `tsc`, which is why these are on.
    "typescript/no-floating-promises": "error",
    // `attributes: false` allows `onSubmit={async () => ...}`, which is how
    // React handlers are written; the checks that matter here are the ones
    // left on -- a promise used as a condition is always truthy.
    "typescript/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],
  },
});
