import { describe, expect, test } from "bun:test";

import {
  accountTypeLabel,
  HOLDS_CASH,
  isAccountKind,
  isAccountType,
  typesFor,
  UNSET_LABEL,
} from "./account-type";

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

test("a credit card holds no cash, every other bank account does", () => {
  // Its balance is what is owed for purchases already counted as spending;
  // counting it as cash would subtract the same money twice, and counting it
  // as an asset would be worse.
  expect(HOLDS_CASH("credit")).toBe(false);
  expect(HOLDS_CASH("current")).toBe(true);
  expect(HOLDS_CASH(null)).toBe(true);
});
