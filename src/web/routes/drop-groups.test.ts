import { describe, expect, test } from "vitest";

import { accountsForKind, groupDropped, type Dropped } from "./drop-groups.ts";

const entry = (name: string, kind: Dropped["kind"], accountId: number | null): Dropped => ({
  name,
  kind,
  accountId,
  reason: "",
  file: new File([""], name),
});

describe("groupDropped", () => {
  test("groups files by kind and account, keeping the drop order", () => {
    const groups = groupDropped([
      entry("a.csv", "bank-statement", 1),
      entry("b.csv", "broker-transactions", 2),
      entry("c.csv", "bank-statement", 1),
    ]);
    expect(groups.map((g) => [g.kind, g.accountId, g.files.map((f) => f.name)])).toEqual([
      ["bank-statement", 1, ["a.csv", "c.csv"]],
      ["broker-transactions", 2, ["b.csv"]],
    ]);
  });

  test("files without an account are kept apart so nothing is previewed for them", () => {
    const groups = groupDropped([entry("a.csv", "bank-statement", null)]);
    expect(groups).toMatchObject([{ accountId: null }]);
  });
});

describe("accountsForKind", () => {
  const accounts = [
    { id: 1, name: "Bank", kind: "bank" as const },
    { id: 2, name: "Broker", kind: "brokerage" as const },
  ];
  test("bank statements go to bank accounts, the others to brokerage accounts", () => {
    expect(accountsForKind("bank-statement", accounts).map((a) => a.id)).toEqual([1]);
    expect(accountsForKind("holdings-statement", accounts).map((a) => a.id)).toEqual([2]);
    expect(accountsForKind("broker-transactions", accounts).map((a) => a.id)).toEqual([2]);
    expect(accountsForKind("unknown", accounts)).toEqual([]);
  });
});
