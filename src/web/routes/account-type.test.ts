import { describe, expect, test } from "bun:test";

import { accountTypeLabel, isAccountType, UNSET_LABEL } from "./account-type";

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
