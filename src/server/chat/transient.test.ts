import { APIConnectionError, APIConnectionTimeoutError, APIError } from "@anthropic-ai/sdk";
import { describe, expect, test } from "vitest";

import { isTransientFailure } from "./transient.ts";

const apiError = (status: number) => APIError.generate(status, {}, "x", new Headers());

describe("isTransientFailure", () => {
  test.each([
    ["network", new TypeError("fetch failed")],
    ["abort", new DOMException("aborted", "AbortError")],
    ["timeout", new DOMException("timed out", "TimeoutError")],
    ["sdk connection", new APIConnectionError({ message: "down" })],
    ["sdk timeout", new APIConnectionTimeoutError()],
    ["429", apiError(429)],
    ["500", apiError(500)],
    ["overloaded 529", apiError(529)],
  ])("%s is transient", (_name, cause) => {
    expect(isTransientFailure(cause)).toBe(true);
  });

  test.each([
    ["refusal", new Error("Malli kieltäytyi vastaamasta tähän pyyntöön")],
    ["400", apiError(400)],
    ["401", apiError(401)],
    ["string", "boom"],
  ])("%s is not", (_name, cause) => {
    expect(isTransientFailure(cause)).toBe(false);
  });
});
