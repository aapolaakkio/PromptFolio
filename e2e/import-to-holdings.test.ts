import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realFetch } from "../src/server/test-network-guard";

/**
 * Task 21's end-to-end smoke test: sign up, create an account, register
 * instruments, import a real broker export, and read the resulting
 * holdings back -- with real HTTP, a real SQLite file on disk, and no
 * mocks anywhere in the request path.
 *
 * --- Why this is a real child process, not an in-process createServer() call ---
 *
 * `src/server/index.ts`'s `createServer()` factory (this task's other
 * deliverable) is what a same-process test *could* call directly. This
 * file deliberately does not, for two reasons that only became visible
 * once the rest of the server test suite (accounts.test.ts,
 * imports.test.ts, ...) and its `bunfig.toml` preload were read:
 *
 *  1. `src/server/test-setup.ts` (a `[test] preload` script) calls
 *     `getDb()` before any `*.test.ts` file's own code runs, permanently
 *     pinning the shared, process-wide `getDb()` handle -- which every
 *     route module (`accounts.ts`, `instruments.ts`, `imports.ts`,
 *     `portfolio.ts`, `auth.ts`) captures at its own first import -- to a
 *     migrated `:memory:` database. Calling `createServer()` in this same
 *     process would still route every request through that shared
 *     in-memory handle, not a real file, regardless of what `DATABASE_PATH`
 *     this file sets afterwards. Redirecting it (via
 *     `resetDbHandleForTests()`) is exactly what the task brief forbids --
 *     it would desync whichever route module some *other* test file has
 *     already imported from whichever this file imports next, the same
 *     class of bug task-9-report.md documents.
 *  2. `src/server/test-network-guard.ts` (the second `[test] preload`
 *     script) replaces `globalThis.fetch` with one that throws for any
 *     caller that doesn't explicitly opt in. A real, no-mocks HTTP round
 *     trip is the entire point of this test, so it opts in deliberately by
 *     importing that module's `realFetch` export (the genuine `fetch`,
 *     captured before the guard replaces the global) instead of reaching
 *     for the ambient `fetch`.
 *
 * A genuine child process (`bun src/server/index.ts`, spawned below) sidesteps
 * problem 1 entirely: it has its own module registry and its own `getDb()`
 * singleton, bound to the real temporary file this test creates, and never
 * touches the parent `bun test` process's shared in-memory handle. Problem 2
 * doesn't apply to the child either -- `bunfig.toml`'s `[test] preload` only
 * runs for `bun test`, not a plain `bun <script>` invocation -- but this
 * process (the one running this test file) still needs `realFetch` for the
 * HTTP calls it makes *to* that child.
 *
 * --- What this test does and does not prove ---
 *
 * It exercises the real HTTP + database spine: routing, auth/session
 * cookies, request validation, the CSV and OP-paste import parsers, the
 * commit/dedupe logic, and the holdings valuation query, all through actual
 * network calls against an actual SQLite file. It does NOT render any React
 * component and cannot catch a client-side rendering bug -- see this
 * project's task-21-report.md for the concrete incident that motivates
 * writing that limitation down instead of leaving it implied.
 */

const PROJECT_ROOT = join(import.meta.dir, "..");
const STARTUP_TIMEOUT_MS = 15_000;

/** Reads stdout up to its first newline and pulls the "http://host:port/" URL out of it. */
const readStartupUrl = async (stdout: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!buffer.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) {
        throw new Error(
          `Palvelinprosessi sulkeutui ennen kuuntelu-osoitteen tulostamista (stdout tähän ` +
            `mennessä: ${JSON.stringify(buffer)})`,
        );
      }
      buffer += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  const match = /https?:\/\/\S+/.exec(buffer);
  if (!match) throw new Error(`Kuuntelu-osoitetta ei löytynyt palvelimen tulosteesta: ${buffer}`);
  return match[0];
};

/** Starts the real server as its own OS process, on an OS-assigned port, against `dbPath`. */
const startTestServer = async (dbPath: string) => {
  // 64 hex-ish characters, well over betterAuth's 32-character minimum
  // (see auth.ts's resolveAuthSecret) -- unique per test run, never reused.
  const secret = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const proc = Bun.spawn({
    cmd: ["bun", "src/server/index.ts"],
    cwd: PROJECT_ROOT,
    env: {
      ...Bun.env,
      DATABASE_PATH: dbPath,
      ALLOW_SIGNUP: "true",
      BETTER_AUTH_SECRET: secret,
      PORT: "0",
      // Not "production": that would also register the real price/FX
      // scheduler (see index.ts's import.meta.main block), which this test
      // has no business starting.
      NODE_ENV: "test",
    },
    stdout: "pipe",
    // Inherited rather than piped: this test never needs to read stderr
    // programmatically, and piping it without ever draining it would risk
    // filling the OS pipe buffer and stalling the child. Inheriting also
    // means a real startup failure's stack trace shows up directly in this
    // test's own output instead of being silently discarded.
    stderr: "inherit",
    stdin: "ignore",
  });
  const url = await Promise.race([
    readStartupUrl(proc.stdout),
    new Promise<string>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error(`Palvelin ei käynnistynyt ${STARTUP_TIMEOUT_MS} ms:n kuluessa`)),
        STARTUP_TIMEOUT_MS,
      );
    }),
  ]);
  return { proc, base: new URL(url).origin };
};

type TestServer = Awaited<ReturnType<typeof startTestServer>>;

let scratchDir = "";
let dbPath = "";
let testServer: TestServer | undefined;

const requireTestServer = (): TestServer => {
  if (!testServer) throw new Error("Testipalvelin ei ole käynnissä");
  return testServer;
};

beforeAll(async () => {
  scratchDir = mkdtempSync(join(tmpdir(), "promptfolio-e2e-"));
  dbPath = join(scratchDir, "e2e.db");

  // Migrated from *this* process via openDb()/migrate() directly -- never
  // getDb() -- so this connection is entirely independent of the shared
  // handle test-setup.ts already pinned to :memory: for this same process.
  // Closed immediately after: the server subprocess opens its own
  // connection to the same file once it starts.
  const { openDb, migrate } = await import("../src/server/db");
  const handle = openDb(dbPath);
  migrate(handle.db);
  handle.sqlite.close();

  testServer = await startTestServer(dbPath);
}, 20_000);

afterAll(async () => {
  if (testServer) {
    testServer.proc.kill();
    await testServer.proc.exited;
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // Already gone -- WAL/SHM siblings only exist once something wrote
      // through them, and close() may already have checkpointed them away.
    }
  }
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

type CallInit = {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: BodyInit;
};

/** One authenticated session's real HTTP client: carries whatever session cookie the last response set. */
type Session = { call(path: string, init?: CallInit): Promise<Response> };

const newSession = (): Session => {
  let cookie = "";
  return {
    call: async (path, init = {}) => {
      const response = await realFetch(`${requireTestServer().base}${path}`, {
        method: init.method,
        body: init.body,
        headers: { ...init.headers, cookie },
      });
      const setCookie = response.headers.getSetCookie().find((c) => c.includes("session_token"));
      const nameValue = setCookie?.split(";")[0];
      if (nameValue) cookie = nameValue;
      return response;
    },
  };
};

const jsonHeaders = { "content-type": "application/json" };

/** Signs up a fresh user (ALLOW_SIGNUP=true, set on the spawned server above) and returns its session. */
const signUp = async (email: string): Promise<Session> => {
  const session = newSession();
  const response = await session.call("/api/auth/sign-up/email", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ email, password: "correct horse battery staple", name: "E2E" }),
  });
  if (response.status !== 200) {
    throw new Error(
      `Rekisteröityminen epäonnistui (status ${response.status}): ${await response.text()}`,
    );
  }
  return session;
};

const createAccount = async (
  session: Session,
  body: { name: string; broker: "nordnet" | "op" },
): Promise<number> => {
  const response = await session.call("/api/accounts", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  // SAFETY: a 201 from POST /api/accounts (asserted above) always returns
  // the inserted row, which carries an `id` column -- see accounts.ts.
  const created = (await response.json()) as { id: number };
  return created.id;
};

const registerInstrument = async (
  session: Session,
  body: { isin: string; name: string; kind: "stock" | "etf" | "fund"; currency: string },
): Promise<void> => {
  const response = await session.call("/api/instruments", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      isin: body.isin,
      ticker: null,
      name: body.name,
      kind: body.kind,
      currency: body.currency,
      priceSource: "manual",
      sourceKey: body.isin,
    }),
  });
  expect(response.status).toBe(201);
};

type HoldingView = {
  readonly isin: string;
  readonly quantity: string;
  readonly costEur: string | null;
  readonly valueEur: string | null;
  readonly unrealisedEur: string | null;
  readonly costBasisError: { readonly tradeDate: string; readonly message: string } | null;
};

const getHoldings = async (session: Session): Promise<HoldingView[]> => {
  const response = await session.call("/api/holdings");
  expect(response.status).toBe(200);
  // SAFETY: a 200 from GET /api/holdings (asserted above) always returns
  // the HoldingView[] shape valuation.ts's holdingsFor() builds.
  return (await response.json()) as HoldingView[];
};

const findHolding = (holdings: readonly HoldingView[], isin: string): HoldingView => {
  const holding = holdings.find((h) => h.isin === isin);
  if (!holding) throw new Error(`Holding for ${isin} not found in ${JSON.stringify(holdings)}`);
  return holding;
};

// --- Fixture-derived instruments ---
//
// The Nordnet fixture (src/server/import/fixtures/nordnet-sample.csv) has
// no Nokia or IWDA row at all -- an earlier version of this test's brief
// assumed a fixture that does not exist. The real fixture's two mapped
// ISINs are a WisdomTree ETF bought once, and a Nordnet in-house fund
// SOLD once with no earlier BUY anywhere in the file -- which happens to
// be exactly the "unmatched disposal" degrade-per-position case this task
// was also asked to exercise, without this test needing to construct it
// by hand.
const WISDOMTREE = { isin: "IE0002Y8CX98", name: "WisdomTree Europe Defence UCITS ETF - EUR Acc" };
const NORDNET_SUOMI = { isin: "SE0005993102", name: "Nordnet Suomi Indeksi" };

// The OP paste fixture (src/server/import/fixtures/op-web-paste-sample.txt)
// carries no ISIN column at all -- every row resolves by instrument name.
// These ISINs are this test's own invention (UpsertInstrument only checks
// the ISIN's *shape*, not a real checksum or registry lookup) purely so
// the instrument can be created; the import itself never sends or checks
// them.
const OP_MAAILMA = { isin: "FI4000297767", name: "OP-Maailma Indeksi A" };
const ESIMERKKI = { isin: "FI0009003727", name: "Esimerkki Oyj" };

test("Nordnet CSV: signs up, imports real broker rows, reports a degraded unmatched-disposal holding, and a re-import is a no-op", async () => {
  const session = await signUp(`e2e-nordnet-${crypto.randomUUID()}@example.com`);
  const accountId = await createAccount(session, { name: "Nordnet", broker: "nordnet" });

  // Both fixture ISINs must be registered before commit will accept the
  // import at all (commitDraft refuses on any unknownIsins) -- see
  // imports.ts's commitDraft() and map.test.ts's own coverage of this
  // exact fixture for the row counts asserted below.
  await registerInstrument(session, { ...WISDOMTREE, kind: "etf", currency: "EUR" });
  await registerInstrument(session, { ...NORDNET_SUOMI, kind: "fund", currency: "EUR" });

  const nordnetBytes = await Bun.file(
    join(PROJECT_ROOT, "src/server/import/fixtures/nordnet-sample.csv"),
  ).arrayBuffer();
  // Read as raw bytes, not `.text()`: the fixture is UTF-16LE, and reading
  // it as text would silently re-encode it to UTF-8 before it ever reaches
  // the server, corrupting the exact bytes detectBrokerConfig() has to
  // sniff.
  const buildForm = (): FormData => {
    const form = new FormData();
    form.set("accountId", String(accountId));
    form.set("file", new File([nordnetBytes], "nordnet-sample.csv", { type: "text/csv" }));
    return form;
  };

  const preview = await session.call("/api/imports/preview", { method: "POST", body: buildForm() });
  expect(preview.status).toBe(200);
  // SAFETY: a 200 from POST /api/imports/preview (asserted above) always
  // returns { broker, filename, sha256, txns, problems, unknownIsins }.
  const previewBody = (await preview.json()) as { txns: unknown[]; unknownIsins: unknown[] };
  // 13 data rows in the fixture; 4 (the VAIHTO merger pair and the two
  // DESIM rows) are deliberately left unmapped by brokers.ts's typeMap, so
  // 9 reach the draft as transactions -- see map.test.ts.
  expect(previewBody.unknownIsins).toEqual([]);
  expect(previewBody.txns).toHaveLength(9);

  const commit = await session.call("/api/imports/commit", { method: "POST", body: buildForm() });
  expect(commit.status).toBe(201);
  // SAFETY: a 201 from POST /api/imports/commit (asserted above) always
  // returns { importId, inserted, skipped }.
  const committed = (await commit.json()) as { inserted: number; skipped: number };
  expect(committed.inserted).toBe(9);
  expect(committed.skipped).toBe(0);

  // Re-importing the exact same file for the same account must be a no-op:
  // every row is a duplicate (Nordnet rows carry an externalId -- the "Id"
  // column -- so dedupe is by that, not by content hash), nothing is
  // inserted a second time, and the ledger -- and therefore the holdings
  // below -- must be unaffected by having "imported" twice.
  const recommit = await session.call("/api/imports/commit", {
    method: "POST",
    body: buildForm(),
  });
  expect(recommit.status).toBe(201);
  // SAFETY: see the first commit's SAFETY comment above; same shape.
  const recommitted = (await recommit.json()) as { inserted: number; skipped: number };
  expect(recommitted.inserted).toBe(0);
  expect(recommitted.skipped).toBe(9);

  const holdings = await getHoldings(session);

  const wisdomTree = findHolding(holdings, WISDOMTREE.isin);
  expect(wisdomTree.quantity).toBe("2.000000"); // one BUY of 2 units, never sold
  expect(wisdomTree.costEur).toBe("68.00"); // 2 * 34.00 EUR, no fee
  expect(wisdomTree.costBasisError).toBeNull();

  // The fixture's MYYNTI (SELL) row disposes of 5 units of Nordnet Suomi
  // Indeksi with no earlier BUY anywhere in the file -- a genuine
  // unmatched disposal, not a contrived one. holdingsFor() must still
  // return this position (never drop it, never 400 the whole request):
  // quantity as the honest signed ledger fact, every money field null, and
  // a Finnish explanation naming exactly this instrument and trade date.
  const nordnetSuomi = findHolding(holdings, NORDNET_SUOMI.isin);
  expect(nordnetSuomi.quantity).toBe("-5.000000");
  expect(nordnetSuomi.costEur).toBeNull();
  expect(nordnetSuomi.valueEur).toBeNull();
  expect(nordnetSuomi.unrealisedEur).toBeNull();
  expect(nordnetSuomi.costBasisError?.tradeDate).toBe("2025-02-01");
  expect(nordnetSuomi.costBasisError?.message).toContain(NORDNET_SUOMI.isin);

  // /api/allocation's response shape changed from a bare array to
  // { slices, excludedInstruments } (see portfolio.ts) -- exercised here
  // rather than assumed, and the same unmatched disposal must show up as
  // an excluded instrument, not silently dropped from the pie.
  const allocation = await session.call("/api/allocation");
  expect(allocation.status).toBe(200);
  // SAFETY: a 200 from GET /api/allocation (asserted above) always returns
  // { slices, excludedInstruments } -- see portfolio.ts.
  const allocationBody = (await allocation.json()) as {
    slices: unknown[];
    excludedInstruments: Array<{ isin: string }>;
  };
  expect(allocationBody.excludedInstruments.map((e) => e.isin)).toContain(NORDNET_SUOMI.isin);
});

test("OP paste: resolves instruments by name (no ISIN column), imports, and a re-import is a no-op", async () => {
  const session = await signUp(`e2e-op-${crypto.randomUUID()}@example.com`);
  const accountId = await createAccount(session, { name: "OP", broker: "op" });

  // OP's web-paste view carries no ISIN column at all -- resolution is by
  // instrument name alone (case-insensitive), so these must be registered
  // by name before the paste can commit.
  await registerInstrument(session, { ...OP_MAAILMA, kind: "fund", currency: "EUR" });
  await registerInstrument(session, { ...ESIMERKKI, kind: "stock", currency: "EUR" });

  const pasteText = await Bun.file(
    join(PROJECT_ROOT, "src/server/import/fixtures/op-web-paste-sample.txt"),
  ).text();
  const pasteBody = JSON.stringify({ text: pasteText, accountId });

  const preview = await session.call("/api/imports/op-paste/preview", {
    method: "POST",
    headers: jsonHeaders,
    body: pasteBody,
  });
  expect(preview.status).toBe(200);
  // SAFETY: a 200 from POST /api/imports/op-paste/preview (asserted above)
  // returns the same Draft shape the CSV preview route does.
  const previewBody = (await preview.json()) as { txns: unknown[]; unknownIsins: unknown[] };
  expect(previewBody.unknownIsins).toEqual([]);
  // Two OSTO (BUY) rows for OP-MAAILMA INDEKSI A, one MYYNTI (SELL) and one
  // OSINKO (DIVIDEND) row for ESIMERKKI OYJ -- see map.test.ts.
  expect(previewBody.txns).toHaveLength(4);

  const commit = await session.call("/api/imports/op-paste/commit", {
    method: "POST",
    headers: jsonHeaders,
    body: pasteBody,
  });
  expect(commit.status).toBe(201);
  // SAFETY: a 201 from POST /api/imports/op-paste/commit (asserted above)
  // always returns { importId, inserted, skipped }.
  const committed = (await commit.json()) as { inserted: number; skipped: number };
  expect(committed.inserted).toBe(4);
  expect(committed.skipped).toBe(0);

  // OP rows carry no externalId at all (no "Id" column exists in a paste),
  // so re-import dedupe here exercises the content-hash path specifically,
  // not the external-id path the Nordnet test above already covers.
  const recommit = await session.call("/api/imports/op-paste/commit", {
    method: "POST",
    headers: jsonHeaders,
    body: pasteBody,
  });
  expect(recommit.status).toBe(201);
  // SAFETY: see the first commit's SAFETY comment above; same shape.
  const recommitted = (await recommit.json()) as { inserted: number; skipped: number };
  expect(recommitted.inserted).toBe(0);
  expect(recommitted.skipped).toBe(4);

  const holdings = await getHoldings(session);

  const opMaailma = findHolding(holdings, OP_MAAILMA.isin);
  expect(opMaailma.quantity).toBe("2.300000"); // 1.2000 + 1.1000 kpl, both BUY
  expect(opMaailma.costBasisError).toBeNull();

  // The fixture's MYYNTI row sells 15 units of ESIMERKKI OYJ with no earlier
  // BUY in this paste -- another genuine unmatched disposal, this time
  // through the wholly separate OP paste parser/route. The OSINKO row's
  // "Määrä" (shares held, not units transacted) must not have contributed
  // to this quantity either.
  const esimerkki = findHolding(holdings, ESIMERKKI.isin);
  expect(esimerkki.quantity).toBe("-15.000000");
  expect(esimerkki.costEur).toBeNull();
  expect(esimerkki.costBasisError?.tradeDate).toBe("2025-10-20");
  expect(esimerkki.costBasisError?.message).toContain(ESIMERKKI.isin);
});
