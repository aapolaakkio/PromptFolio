import { describe, expect, test } from "vitest";

import type { ProposalAction } from "../../server/chat/proposal-schema.ts";

// Every POST server function is either the Confirm of the chat cards listed (by action) or listed with why not, so the list cannot go stale.

const INVENTORY = {
  createAccount: ["create_account"],
  editAccount: ["edit_account"],
  recordAccountBalance: ["account_balance"],
  saveCashEntry: ["cash_entry"],
  deleteCashEntry: ["delete_cash_entry"],
  removeConversation: ["remove_conversation"],
  saveForecastRate: ["forecast_rate"],
  deleteForecastRate: ["clear_forecast_rate"],
  undoImport: ["undo_import"],
  createInstrument: ["create_instrument"],
  editInstrument: ["price_source"],
  setFundCharge: ["fund_fee", "clear_fund_fee"],
  savePrice: ["record_price"],
  saveTargetAllocation: ["target_allocation"],
  deletePlanRow: ["delete_plan_row"],
  savePlan: ["monthly_plan"],
  saveSnapshot: ["snapshot"],
  removeSnapshot: ["remove_snapshot"],
  adjustSnapshot: ["snapshot_adjust"],
  saveSpendingRules: ["spending_rules"],
  changeSpendingRule: ["spending_rule_category"],
  deleteSpendingRule: ["delete_spending_rule"],
  previewBankImport:
    "not offered: a file upload; a chat message cannot carry a file (Imports page)",
  commitBankDraftImport: "not offered: commits a file's reviewed draft (Imports page)",
  previewImport: "not offered: a file upload (Imports page)",
  commitImportDraft: "not offered: commits a file's reviewed draft (Imports page)",
  previewOpPaste: "not offered: pasted transaction text goes to the Imports page, not chat",
  sortImportFiles: "not offered: sorts uploaded files (Imports page)",
  proposeSnapshotFromCsv: "not offered: a file upload (the account's statements page)",
  proposeSnapshotFromPaste: "not offered: a pasted table, read on the account's statements page",
  proposeSnapshotFromPdf: "not offered: a file upload (the account's statements page)",
  createFirstAccount: "not offered: first-run sign-up with a password",
  savePlanRow: "not offered: one row is the plan card's add mode, saved through savePlan",
  refreshPricesNow: "not offered: saves nothing a person typed; a button on the Prices page",
  explainDifferences: "not offered: reads and explains, saves nothing",
  getSummary: "not offered: reads, saves nothing",
  saveProposalOutcome: "not offered: the card's own outcome note",
  askTurn: "not offered: the chat itself",
} satisfies Readonly<Record<string, string | readonly ProposalAction[]>>;

const servers = import.meta.glob<string>("../server/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});
const actions = import.meta.glob<string>("./proposal-actions.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Every `createServerFn(...)` whose options say POST, however it is laid out or exported. */
const postFunctions = (source: string): string[] =>
  [...source.matchAll(/const\s+(\w+)\s*=\s*createServerFn\(\s*(\{[^)]*\})?\s*\)/g)]
    .filter((match) => /method\s*:\s*["']POST["']/.test(match[2] ?? ""))
    .map((match) => match[1] ?? "");

/** Each action's own entry in `formActions`, so a function counts only under the action that calls it. */
const actionBodies = (source: string): ReadonlyMap<string, string> =>
  new Map(
    [...source.matchAll(/^ {2}(\w+): async \(args\) => \{\n([\s\S]*?)\n {2}\},$/gm)].map(
      (match) => [match[1] ?? "", match[2] ?? ""],
    ),
  );

describe("the scanner", () => {
  test("finds a POST function laid out over several lines or not exported, and skips a GET", () => {
    const source = [
      'export const a = createServerFn({ method: "POST" })',
      "const b = createServerFn({",
      '  method: "POST",',
      "})",
      "export const c = createServerFn()",
      'export const d = createServerFn({ method: "GET" })',
    ].join("\n");
    expect(postFunctions(source)).toEqual(["a", "b"]);
  });
});

describe("the proposal inventory", () => {
  test("lists every POST server function, and nothing that is gone", () => {
    const found = Object.values(servers).flatMap(postFunctions);
    const byName = (a: string, b: string) => a.localeCompare(b);
    expect([...found].sort(byName)).toEqual(Object.keys(INVENTORY).sort(byName));
  });

  test("each proposal function is what its own actions' Confirm calls", () => {
    const bodies = actionBodies(Object.values(actions).join(""));
    const wrong = Object.entries(INVENTORY).flatMap(([name, status]) =>
      !Array.isArray(status)
        ? []
        : status
            .filter((action) => !(bodies.get(action) ?? "").includes(`await ${name}(`))
            .map((action) => `${action} -> ${name}`),
    );
    expect(bodies.size).toBeGreaterThan(20);
    expect(wrong).toEqual([]);
  });
});
