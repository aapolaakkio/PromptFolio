import { describe, expect, test } from "vitest";

import {
  ACCOUNT_TYPES,
  accountTypeLabel,
  isAccountKind,
  isAccountType,
  typesFor,
  UNSET_LABEL,
} from "./account-type.ts";

describe("isAccountType", () => {
  test("accepts the three stored values and nothing else", () => {
    expect(isAccountType("aot")).toBe(true);
    expect(isAccountType("ost")).toBe(true);
    expect(isAccountType("other")).toBe(true);
    expect(isAccountType("AOT")).toBe(false);
    expect(isAccountType("")).toBe(false);
  });
});

describe("accountTypeLabel", () => {
  test("names each type in full, so OST is never mistaken for an ordinary account", () => {
    expect(accountTypeLabel("aot")).toBe("Arvo-osuustili (AOT)");
    expect(accountTypeLabel("ost")).toBe("Osakesäästötili (OST)");
  });

  test("says an unclassified account is unclassified rather than guessing", () => {
    expect(accountTypeLabel(null)).toBe(UNSET_LABEL);
    expect(accountTypeLabel("jotain muuta")).toBe(UNSET_LABEL);
  });
});

describe("typesFor", () => {
  test("offers a bank account only bank types, never AOT or OST", () => {
    const ids = typesFor("bank").map((type) => type.id);
    expect(ids).toEqual(["current", "savings", "fixed_term", "credit"]);
    expect(ids).not.toContain("ost");
  });

  test("offers a brokerage account only its own", () => {
    const ids = typesFor("brokerage").map((type) => type.id);
    expect(ids).toEqual(["aot", "ost", "other"]);
    expect(ids).not.toContain("savings");
  });
});

describe("isAccountKind", () => {
  test("accepts the two kinds and nothing else", () => {
    expect(isAccountKind("bank")).toBe(true);
    expect(isAccountKind("brokerage")).toBe(true);
    expect(isAccountKind("savings")).toBe(false);
  });
});

describe("accountTypeLabel", () => {
  test("names a bank type too, now that both sets share one lookup", () => {
    expect(accountTypeLabel("fixed_term")).toBe("Määräaikaistili");
    expect(accountTypeLabel("current")).toBe("Käyttötili");
  });
});

test("the account schema accepts every type the app can offer", async () => {
  // These were two lists that had to agree and did not: adding a credit card
  // left the wire schema listing the older types, so /api/accounts returned an
  // account zod rejected -- and every screen that reads accounts failed at
  // once, showing "no bank accounts" rather than one odd row.
  const { AccountSchema } = await import("./imports-draft.ts");

  for (const type of ACCOUNT_TYPES) {
    expect(() =>
      AccountSchema.parse({
        id: 1,
        name: "Tili",
        broker: "op",
        kind: type.id === "aot" || type.id === "ost" ? "brokerage" : "bank",
        accountType: type.id,
      }),
    ).not.toThrow();
  }
});
