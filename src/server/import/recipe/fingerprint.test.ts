import { describe, expect, test } from "vitest";

// eslint-disable-next-line anti-slop/no-shape-in-symbol-names -- the term is the domain concept under test; see fingerprint.ts.
import { fingerprint, shape } from "./fingerprint.ts";

// eslint-disable-next-line anti-slop/no-shape-in-symbol-names -- naming the function under test.
describe("shape", () => {
  test("blanks digits so a value cannot change the layout", () => {
    // eslint-disable-next-line anti-slop/no-shape-in-symbol-names -- see fingerprint.ts.
    expect(shape("Tiliote 1.8.2026 - 31.8.2026")).toBe("Tiliote #.#.# - #.#.#");
  });

  test("blanks an account number", () => {
    // eslint-disable-next-line anti-slop/no-shape-in-symbol-names -- see fingerprint.ts.
    expect(shape("FI12 3456 7890 1234 56")).toBe("FI## #### #### #### ##");
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
});
