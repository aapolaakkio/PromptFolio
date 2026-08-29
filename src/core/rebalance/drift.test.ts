import { describe, expect, test } from "bun:test";

import type { AllocationResult, Slice } from "../allocation";
import { EUR, formatMoney, parseMoney } from "../money";
import { driftFor } from "./drift";

const slice = (key: string, valueEur: string, weight: number): Slice => ({
  key,
  label: key,
  valueEur: parseMoney(valueEur, EUR),
  weight,
});

const allocationOf = (slices: Slice[], excludedInstrumentIds: number[] = []): AllocationResult => ({
  slices,
  excludedInstrumentIds,
});

const rowFor = (report: ReturnType<typeof driftFor>, key: string) =>
  report.rows.find((row) => row.key === key)!;

describe("driftFor", () => {
  test("reports the gap in percentage points and in euros", () => {
    // 7 000 € of a 10 000 € portfolio in shares against a 60 % target: ten
    // points over, and 1 000 € would have to move to correct it.
    const report = driftFor({
      allocation: allocationOf([slice("stock", "7000,00", 0.7), slice("fund", "3000,00", 0.3)]),
      targets: [
        { key: "stock", weightBp: 6000 },
        { key: "fund", weightBp: 4000 },
      ],
    });

    expect(rowFor(report, "stock").driftBp).toBe(1000);
    // Negative: this slice is over its target, so money comes out of it.
    expect(formatMoney(rowFor(report, "stock").driftEur!)).toBe("-1000.00");
    expect(formatMoney(rowFor(report, "fund").driftEur!)).toBe("1000.00");
    expect(formatMoney(report.totalEur)).toBe("10000.00");
  });

  test("calls a slice inside the band on target while still carrying its figure", () => {
    const report = driftFor({
      allocation: allocationOf([slice("stock", "6200,00", 0.62), slice("fund", "3800,00", 0.38)]),
      targets: [
        { key: "stock", weightBp: 6000 },
        { key: "fund", weightBp: 4000 },
      ],
    });

    expect(rowFor(report, "stock").withinBand).toBe(true);
    // The figure is still there: the band decides how it reads, not whether it
    // is computed.
    expect(rowFor(report, "stock").driftBp).toBe(200);
  });

  test("respects a band the caller sets", () => {
    const report = driftFor({
      allocation: allocationOf([slice("stock", "6200,00", 0.62), slice("fund", "3800,00", 0.38)]),
      targets: [
        { key: "stock", weightBp: 6000 },
        { key: "fund", weightBp: 4000 },
      ],
      bandBp: 100,
    });

    expect(rowFor(report, "stock").withinBand).toBe(false);
  });

  test("treats a slice with no target as untargeted, not as targeted at zero", () => {
    // Only "I want none of this" implies selling it; "I have not decided" does
    // not, and the two must not render the same.
    const report = driftFor({
      allocation: allocationOf([slice("stock", "6000,00", 0.6), slice("cash", "4000,00", 0.4)]),
      targets: [{ key: "stock", weightBp: 10000 }],
    });

    expect(rowFor(report, "cash").untargeted).toBe(true);
    expect(rowFor(report, "cash").targetBp).toBeNull();
    expect(rowFor(report, "cash").driftEur).toBeNull();
  });

  test("reports a target for something not held at all as the whole target missing", () => {
    // Otherwise a plan to move into a new asset class would show nothing to do.
    const report = driftFor({
      allocation: allocationOf([slice("stock", "10000,00", 1)]),
      targets: [
        { key: "stock", weightBp: 8000 },
        { key: "bond", weightBp: 2000 },
      ],
    });

    expect(rowFor(report, "bond").actualBp).toBe(0);
    expect(formatMoney(rowFor(report, "bond").driftEur!)).toBe("2000.00");
  });

  test("suspends every row's gap when a holding could not be valued", () => {
    // A weight is a share of a total, so one unpriceable holding makes every
    // other slice's gap wrong by an unknown amount -- not only its own.
    const report = driftFor({
      allocation: allocationOf(
        [slice("stock", "6000,00", 0.6), slice("fund", "4000,00", 0.4)],
        [42],
      ),
      targets: [
        { key: "stock", weightBp: 5000 },
        { key: "fund", weightBp: 5000 },
      ],
    });

    expect(report.incomplete).toBe(true);
    expect(report.rows.every((row) => row.driftEur === null)).toBe(true);
    // The percentage figure survives: it is a fact about the slices that could
    // be valued, and it is what tells the reader the shape is off at all.
    expect(rowFor(report, "stock").driftBp).toBe(1000);
  });
});
