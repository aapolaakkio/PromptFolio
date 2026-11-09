import { describe, expect, test } from "vitest";

// Every POST server function is either reachable from a chat card or listed here with why not, so the list cannot go stale.

const PROPOSAL = "proposal";

const INVENTORY = {
  createAccount: PROPOSAL,
  editAccount: PROPOSAL,
  recordAccountBalance: PROPOSAL,
  saveCashEntry: PROPOSAL,
  deleteCashEntry: PROPOSAL,
  removeConversation: PROPOSAL,
  saveForecastRate: PROPOSAL,
  deleteForecastRate: PROPOSAL,
  undoImport: PROPOSAL,
  createInstrument: PROPOSAL,
  editInstrument: PROPOSAL,
  setFundCharge: PROPOSAL,
  savePrice: PROPOSAL,
  saveTargetAllocation: PROPOSAL,
  deletePlanRow: PROPOSAL,
  savePlan: PROPOSAL,
  saveSnapshot: PROPOSAL,
  removeSnapshot: PROPOSAL,
  adjustSnapshot: PROPOSAL,
  saveSpendingRules: PROPOSAL,
  changeSpendingRule: PROPOSAL,
  deleteSpendingRule: PROPOSAL,
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
} satisfies Readonly<Record<string, string>>;

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

const POST = /export const (\w+) = createServerFn\(\{ method: "POST" \}\)/g;

describe("the proposal inventory", () => {
  test("lists every POST server function, and nothing that is gone", () => {
    const found = Object.values(servers).flatMap((source) =>
      [...source.matchAll(POST)].map((match) => match[1] ?? ""),
    );
    const byName = (a: string, b: string) => a.localeCompare(b);
    expect([...found].sort(byName)).toEqual(Object.keys(INVENTORY).sort(byName));
  });

  test("each one marked as a proposal is what a card's Confirm calls", () => {
    const source = Object.values(actions).join("");
    const missing = Object.entries(INVENTORY)
      .filter(([name, status]) => status === PROPOSAL && !source.includes(`await ${name}(`))
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });
});
