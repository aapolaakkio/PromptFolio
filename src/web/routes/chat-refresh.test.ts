import { describe, expect, test, vi } from "vitest";

import { refreshAfterDecision } from "./chat-refresh.ts";

const client = () => ({ invalidateQueries: vi.fn(() => Promise.resolve()) });

describe("refreshAfterDecision", () => {
  test("a saved card refreshes every query, so the page behind the panel shows it", () => {
    const queries = client();
    refreshAfterDecision(queries, { outcome: "saved" });
    expect(queries.invalidateQueries.mock.calls).toEqual([[]]);
  });

  test("a dismissed or failed card refreshes only the conversation", () => {
    const queries = client();
    refreshAfterDecision(queries, { outcome: "dismissed" });
    refreshAfterDecision(queries, { outcome: "failed", detail: "offline" });
    expect(queries.invalidateQueries.mock.calls).toEqual([
      [{ queryKey: ["conversation"] }],
      [{ queryKey: ["conversation"] }],
    ]);
  });
});
