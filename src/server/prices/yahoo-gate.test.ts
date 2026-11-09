import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../db/index.ts";
import { yahooGate } from "../db/schema.ts";
import type { FetchImpl } from "./types.ts";
import { YahooPausedError, gatedFetch, yahooPausedUntil } from "./yahoo-gate.ts";

const MIN = 60_000;
const SIX_HOURS = 21_600_000;
const URL_ = "https://query1.finance.yahoo.com/x";

const stub = (responses: readonly Response[]) => {
  const state = { calls: 0 };
  const fetchImpl = async (): Promise<Response> => {
    const res = responses[Math.min(state.calls, responses.length - 1)];
    state.calls += 1;
    if (res === undefined) throw new Error("no response");
    return res.clone();
  };
  return { state, fetchImpl };
};

const tooMany = (headers?: Record<string, string>): Response =>
  new Response("", { status: 429, headers });

const pauseOf = async (gated: FetchImpl): Promise<number> => {
  try {
    await gated(URL_);
  } catch (err) {
    if (err instanceof YahooPausedError) return err.until;
    throw err;
  }
  throw new Error("expected YahooPausedError");
};

const clock = (start: number) => {
  const t = { now: start };
  return { t, now: () => t.now };
};

beforeEach(async () => {
  await db.delete(yahooGate).run();
});

describe("gatedFetch", () => {
  it("a 429 pauses, and the next call makes no request", async () => {
    const { state, fetchImpl } = stub([tooMany()]);
    const { now } = clock(1_000_000);
    const gated = gatedFetch(db, fetchImpl, now);
    await expect(gated(URL_)).rejects.toBeInstanceOf(YahooPausedError);
    await expect(gated(URL_)).rejects.toBeInstanceOf(YahooPausedError);
    expect(state.calls).toBe(1);
    expect(await yahooPausedUntil(db, now)).toBe(1_000_000 + 15 * MIN);
  });

  it("Retry-After is honoured", async () => {
    const { fetchImpl } = stub([tooMany({ "Retry-After": "120" })]);
    const { now } = clock(5_000);
    expect(await pauseOf(gatedFetch(db, fetchImpl, now))).toBe(5_000 + 120_000);
  });

  it("back-off doubles and caps at six hours", async () => {
    const { fetchImpl } = stub([tooMany()]);
    const { t, now } = clock(0);
    const gated = gatedFetch(db, fetchImpl, now);
    const waits: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const until = await pauseOf(gated);
      waits.push(until - t.now);
      t.now = until;
    }
    expect(waits.slice(0, 3)).toEqual([15 * MIN, 30 * MIN, 60 * MIN]);
    expect(Math.max(...waits)).toBe(SIX_HOURS);
    expect(waits.at(-1)).toBe(SIX_HOURS);
  });

  it("a success resets the back-off", async () => {
    const { fetchImpl: bad } = stub([tooMany()]);
    const { t, now } = clock(0);
    t.now = await pauseOf(gatedFetch(db, bad, now));
    const { fetchImpl: ok } = stub([new Response("ok", { status: 200 })]);
    const res = await gatedFetch(db, ok, now)(URL_);
    expect(res.status).toBe(200);
    expect(await yahooPausedUntil(db, now)).toBeNull();
    expect((await pauseOf(gatedFetch(db, bad, now))) - t.now).toBe(15 * MIN);
  });

  it("Retry-After as an HTTP date is honoured, uncapped", async () => {
    const start = Date.parse("2026-11-09T12:00:00Z");
    const { fetchImpl } = stub([tooMany({ "Retry-After": "Tue, 10 Nov 2026 00:00:00 GMT" })]);
    const { now } = clock(start);
    expect(await pauseOf(gatedFetch(db, fetchImpl, now))).toBe(start + 12 * 60 * MIN);
  });

  it("a non-Yahoo success between two Yahoo 429s does not reset the back-off", async () => {
    const { t, now } = clock(0);
    const routed = async (input: string | URL | Request): Promise<Response> =>
      String(input).includes("finance.yahoo.com") ? tooMany() : new Response("ok", { status: 200 });
    const gated = gatedFetch(db, routed, now);
    t.now = await pauseOf(gated);
    await gated("https://api.openfigi.com/v3/mapping");
    expect((await pauseOf(gated)) - t.now).toBe(30 * MIN);
  });

  it("a non-Yahoo request goes out while Yahoo is paused", async () => {
    const { now } = clock(0);
    await pauseOf(gatedFetch(db, stub([tooMany()]).fetchImpl, now));
    const { state, fetchImpl: ok } = stub([new Response("ok", { status: 200 })]);
    const res = await gatedFetch(db, ok, now)("https://www.op.fi/x");
    expect(res.status).toBe(200);
    expect(state.calls).toBe(1);
    expect(await yahooPausedUntil(db, now)).not.toBeNull();
  });

  it("a non-Yahoo 429 does not pause Yahoo", async () => {
    const { now } = clock(0);
    const res = await gatedFetch(
      db,
      stub([tooMany()]).fetchImpl,
      now,
    )("https://api.openfigi.com/v3/mapping");
    expect(res.status).toBe(429);
    expect(await yahooPausedUntil(db, now)).toBeNull();
  });
});
