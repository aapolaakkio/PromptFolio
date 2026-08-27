import { beforeAll, describe, expect, test } from "bun:test";

// Instruments are shared reference data across the family instance: any
// authenticated user can read and create them, unlike accounts, which are
// scoped per user. This file exercises instrumentRoutes against a real,
// migrated database and a real Better Auth session, mirroring
// src/server/api/accounts.test.ts's setup — including its reliance on
// ../test-setup.ts (a bunfig.toml `[test] preload` script) to have already
// pinned the shared getDb() handle to a migrated in-memory database before
// this file's own code runs. This file must NOT call
// resetDbHandleForTests(), set DATABASE_PATH, or call getDb()/migrate()
// itself — see test-setup.ts's comment for why, and accounts.test.ts's
// comment for the real bug that duplicating that setup caused.

let auth: (typeof import("../auth"))["auth"];
let instrumentRoutes: (typeof import("./instruments"))["instrumentRoutes"];

beforeAll(async () => {
  const authModule = await import("../auth");
  const instrumentsModule = await import("./instruments");
  auth = authModule.auth;
  instrumentRoutes = instrumentsModule.instrumentRoutes;
});

const sessionCookieFrom = (response: Response): string => {
  const setCookie = response.headers.getSetCookie().find((c) => c.includes("session_token"));
  if (!setCookie) throw new Error("Response carried no session_token cookie");
  const nameValue = setCookie.split(";")[0];
  if (!nameValue) throw new Error("Malformed Set-Cookie header");
  return nameValue;
};

const signUp = async (email: string): Promise<{ cookie: string }> => {
  const response = await auth.handler(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Test User", email, password: "correct horse battery staple" }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed with status ${response.status}`);
  return { cookie: sessionCookieFrom(response) };
};

interface InstrumentPayload {
  isin: string;
  ticker: string | null;
  name: string;
  kind: "stock" | "etf" | "fund" | "cash";
  currency: "EUR" | "USD";
  priceSource: "yahoo" | "nordnet_fund" | "op_fund" | "spankki_fund" | "danske_fund" | "manual";
  sourceKey: string;
}

const validInstrument = (overrides: Partial<InstrumentPayload> = {}): InstrumentPayload => ({
  isin: "FI0009000681",
  ticker: "NOKIA.HE",
  name: "Nokia",
  kind: "stock",
  currency: "EUR",
  priceSource: "yahoo",
  sourceKey: "NOKIA.HE",
  ...overrides,
});

describe("GET /api/instruments", () => {
  test("rejects a request with no session", async () => {
    const response = await instrumentRoutes["/api/instruments"].GET(
      new Request("http://x/api/instruments"),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Kirjautuminen vaaditaan" });
  });

  test("is readable by any authenticated user, not only the creator", async () => {
    const creator = await signUp(`instr-creator-${crypto.randomUUID()}@example.com`);
    const reader = await signUp(`instr-reader-${crypto.randomUUID()}@example.com`);

    await instrumentRoutes["/api/instruments"].POST(
      new Request("http://x/api/instruments", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: creator.cookie },
        body: JSON.stringify(validInstrument({ isin: "FI0009007806", sourceKey: "SAMPO.HE" })),
      }),
    );

    const response = await instrumentRoutes["/api/instruments"].GET(
      new Request("http://x/api/instruments", { headers: { cookie: reader.cookie } }),
    );
    expect(response.status).toBe(200);
    // SAFETY: a 200 from GET /api/instruments (asserted above) always
    // returns the instruments array shape instrumentRoutes' GET builds.
    const body = (await response.json()) as Array<{ isin: string }>;
    expect(body.some((i) => i.isin === "FI0009007806")).toBe(true);
  });
});

describe("POST /api/instruments", () => {
  test("rejects a request with no session", async () => {
    const response = await instrumentRoutes["/api/instruments"].POST(
      new Request("http://x/api/instruments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validInstrument()),
      }),
    );
    expect(response.status).toBe(401);
  });

  test("creates an instrument", async () => {
    const { cookie } = await signUp(`instr-create-${crypto.randomUUID()}@example.com`);
    const response = await instrumentRoutes["/api/instruments"].POST(
      new Request("http://x/api/instruments", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(validInstrument({ isin: "FI0009013403", sourceKey: "KNEBV.HE" })),
      }),
    );
    expect(response.status).toBe(201);
    // SAFETY: a 201 from POST /api/instruments (asserted above) always
    // returns the inserted row, which carries an isin and a name.
    const body = (await response.json()) as { isin: string; name: string };
    expect(body.isin).toBe("FI0009013403");
    expect(body.name).toBe("Nokia");
  });

  test("rejects a duplicate ISIN with a 409 naming the ISIN", async () => {
    const { cookie } = await signUp(`instr-dup-${crypto.randomUUID()}@example.com`);
    const dup = validInstrument({ isin: "FI0009000202", sourceKey: "KESKOB.HE" });
    const first = await instrumentRoutes["/api/instruments"].POST(
      new Request("http://x/api/instruments", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(dup),
      }),
    );
    expect(first.status).toBe(201);

    const second = await instrumentRoutes["/api/instruments"].POST(
      new Request("http://x/api/instruments", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(dup),
      }),
    );
    expect(second.status).toBe(409);
    // SAFETY: handle()'s HttpError branch (asserted above via status 409)
    // always shapes its body as `{ error }`.
    const body = (await second.json()) as { error: string };
    expect(body.error).toContain("FI0009000202");
  });

  test("rejects a malformed ISIN with 400 field detail", async () => {
    const { cookie } = await signUp(`instr-bad-isin-${crypto.randomUUID()}@example.com`);
    const response = await instrumentRoutes["/api/instruments"].POST(
      new Request("http://x/api/instruments", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(validInstrument({ isin: "not-an-isin" })),
      }),
    );
    expect(response.status).toBe(400);
    // SAFETY: handle()'s ZodError branch (asserted above via status 400)
    // always shapes its body as `{ error, fields: [{ path, message }] }`.
    const body = (await response.json()) as { fields: Array<{ path: string }> };
    expect(body.fields.map((f) => f.path)).toContain("isin");
  });
});
