import { describe, expect, test } from "vitest";

import { blankDigits, fingerprint } from "./fingerprint.ts";

describe("blankDigits", () => {
  test("blanks digits so a value cannot change the layout", () => {
    expect(blankDigits("Tiliote 1.8.2026 - 31.8.2026")).toBe("Tiliote #.#.# - #.#.#");
  });

  test("blanks an account number", () => {
    expect(blankDigits("FI12 3456 7890 1234 56")).toBe("FI#");
  });
});

describe("fingerprint", () => {
  test("two statements of different months share a fingerprint", () => {
    const august = ["Tiliote", "1.8.2026 - 31.8.2026", "FI12 3456 7890 1234 56"];
    const september = ["Tiliote", "1.9.2026 - 30.9.2026", "FI12 3456 7890 1234 56"];

    expect(fingerprint("pdfTeX", august)).toBe(fingerprint("pdfTeX", september));
  });

  test("a different layout gets a different fingerprint", () => {
    const op = ["Tiliote", "1.8.2026 - 31.8.2026"];
    const other = ["Kontoutdrag", "2026-08-01 - 2026-08-31"];

    expect(fingerprint("pdfTeX", op)).not.toBe(fingerprint("pdfTeX", other));
  });

  test("a different producer gets a different fingerprint", () => {
    const lines = ["Tiliote", "1.8.2026 - 31.8.2026"];
    expect(fingerprint("pdfTeX", lines)).not.toBe(fingerprint("Word", lines));
  });

  test("a day gaining a digit does not change the fingerprint", () => {
    const nineDays = ["Tiliote", "1.8.2026 - 9.8.2026"];
    const tenDays = ["Tiliote", "10.8.2026 - 30.8.2026"];

    expect(fingerprint("pdfTeX", nineDays)).toBe(fingerprint("pdfTeX", tenDays));
  });

  test("an amount gaining a digit does not change the fingerprint", () => {
    const small = ["Tiliote", "Saldo 1 500,00"];
    const large = ["Tiliote", "Saldo 12 500,00"];

    expect(fingerprint("pdfTeX", small)).toBe(fingerprint("pdfTeX", large));
  });

  test("a page marker gaining a digit does not change the fingerprint", () => {
    const nine = ["Tiliote", "1 (9)"];
    const ten = ["Tiliote", "1 (10)"];

    expect(fingerprint("pdfTeX", nine)).toBe(fingerprint("pdfTeX", ten));
  });

  test("a balance crossing a power of ten does not change the fingerprint", () => {
    const underThousand = ["Tiliote", "Saldo 999,99"];
    const overThousand = ["Tiliote", "Saldo 1 000,00"];

    expect(fingerprint("pdfTeX", underThousand)).toBe(fingerprint("pdfTeX", overThousand));
  });
});
