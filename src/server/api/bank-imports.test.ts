import { beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";

// Importing a statement writes several hundred cash rows at once, so these
// tests care about the three ways that goes wrong: onto the wrong kind of
// account, twice over, or without the balance that came before it.

let auth: (typeof import("../auth"))["auth"];
let accountRoutes: (typeof import("./accounts"))["accountRoutes"];
let bankImportRoutes: (typeof import("./bank-imports"))["bankImportRoutes"];
let setClassifierClient: (typeof import("./bank-imports"))["_setClassifierClient"];
let importRoutes: (typeof import("./imports"))["importRoutes"];
let portfolioRoutes: (typeof import("./portfolio"))["portfolioRoutes"];

beforeAll(async () => {
  auth = (await import("../auth")).auth;
  accountRoutes = (await import("./accounts")).accountRoutes;
  const bankImports = await import("./bank-imports");
  bankImportRoutes = bankImports.bankImportRoutes;
  setClassifierClient = bankImports._setClassifierClient;
  importRoutes = (await import("./imports")).importRoutes;
  portfolioRoutes = (await import("./portfolio")).portfolioRoutes;
});

const sessionCookieFrom = (response: Response): string => {
  const setCookie = response.headers.getSetCookie().find((c) => c.includes("session_token"));
  if (!setCookie) throw new Error("Response carried no session_token cookie");
  const nameValue = setCookie.split(";")[0];
  if (!nameValue) throw new Error("Malformed Set-Cookie header");
  return nameValue;
};

const signUp = async (): Promise<string> => {
  const response = await auth.handler(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Test User",
        email: `bank-import-${crypto.randomUUID()}@example.com`,
        password: "correct horse battery staple",
      }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed with status ${response.status}`);
  return sessionCookieFrom(response);
};

const IdSchema = z.object({ id: z.number() });
const ErrorSchema = z.object({ error: z.string() });
const CommitSchema = z.object({
  importId: z.number(),
  inserted: z.number(),
  skipped: z.number(),
  problems: z.array(z.object({ line: z.number(), message: z.string() })),
});
const PreviewSchema = z.object({
  bank: z.string(),
  rows: z.number(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  totalInEur: z.string(),
  totalOutEur: z.string(),
  openingBalanceEur: z.string().nullable(),
  closingBalanceEur: z.string().nullable(),
  verified: z.boolean(),
  sample: z.array(z.object({ date: z.string(), type: z.string(), amountEur: z.string() })),
});

const PdfCommitSchema = CommitSchema.extend({
  maturityDate: z.string().nullable(),
  maturityConflict: z.string().nullable(),
  reconciliation: z
    .object({
      statedClosingEur: z.string(),
      ledgerClosingEur: z.string(),
      differenceEur: z.string(),
      openingBalanceWritten: z.boolean(),
      openingBalanceDate: z.string(),
    })
    .nullable(),
});
const BalanceSchema = z.object({
  statedEur: z.string(),
  derivedFromRowsEur: z.string(),
  openingBalanceEur: z.string(),
  openingBalanceDate: z.string(),
});
const CashSchema = z.object({ totalEur: z.string() });

const BANK_TYPES = new Set(["current", "savings", "fixed_term"]);

const openAccount = async (cookie: string, accountType: string | null): Promise<number> => {
  const body =
    accountType === null
      ? { name: "Nordnet", broker: "nordnet" }
      : {
          name: "OP käyttötili",
          broker: "op",
          kind: BANK_TYPES.has(accountType) ? "bank" : "brokerage",
          accountType,
        };
  const response = await accountRoutes["/api/accounts"].POST(
    new Request("http://x/api/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    }),
  );
  expect(response.status).toBe(201);
  return IdSchema.parse(await response.json()).id;
};

const statement = async (): Promise<ArrayBuffer> =>
  Bun.file(`${import.meta.dir}/../import/fixtures/op-bank-sample.csv`).arrayBuffer();

/**
 * SAFETY: `TextEncoder.encode` always returns a `Uint8Array` over a plain
 * `ArrayBuffer`, never a `SharedArrayBuffer`, which the DOM union cannot say.
 */
const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

const upload = async (
  path: "/api/imports/bank/preview" | "/api/imports/bank/commit",
  cookie: string,
  accountId: number,
  bytes?: ArrayBuffer,
): Promise<Response> => {
  const form = new FormData();
  form.append("file", new File([bytes ?? (await statement())], "tapahtumat.csv"));
  form.append("accountId", String(accountId));
  return bankImportRoutes[path].POST(
    new Request(`http://x${path}`, { method: "POST", headers: { cookie }, body: form }),
  );
};

const cashTotal = async (cookie: string, on: string): Promise<string> => {
  const response = await portfolioRoutes["/api/cash"].GET(
    new Request(`http://x/api/cash?on=${on}`, { headers: { cookie } }),
  );
  return CashSchema.parse(await response.json()).totalEur;
};

describe("POST /api/imports/bank/preview", () => {
  test("rejects a request with no session", async () => {
    const response = await upload("/api/imports/bank/preview", "", 1);
    expect(response.status).toBe(401);
  });

  test("summarises the file without writing anything", async () => {
    const cookie = await signUp();
    const accountId = await openAccount(cookie, "current");

    const body = PreviewSchema.parse(
      await (await upload("/api/imports/bank/preview", cookie, accountId)).json(),
    );

    expect(body.bank).toBe("op");
    expect(body.rows).toBe(5);
    expect(body.from).toBe("2025-09-01");
    expect(body.to).toBe("2026-01-02");
    expect(body.totalInEur).toBe("2762.34");
    expect(body.totalOutEur).toBe("-1102.05");
    expect(body.sample[0]?.type).toBe("WITHDRAWAL");
    // Nothing committed.
    expect(await cashTotal(cookie, "2026-06-01")).toBe("0.00");
  });

  test("refuses a brokerage account, where spending would corrupt the returns", async () => {
    const cookie = await signUp();
    const brokerage = await openAccount(cookie, "aot");

    const response = await upload("/api/imports/bank/preview", cookie, brokerage);
    expect(response.status).toBe(400);
    expect(ErrorSchema.parse(await response.json()).error).toContain("pankkitilille");
  });

  test("refuses an unclassified account rather than guessing it is a bank one", async () => {
    const cookie = await signUp();
    const unclassified = await openAccount(cookie, null);

    expect((await upload("/api/imports/bank/preview", cookie, unclassified)).status).toBe(400);
  });

  test("refuses a file that is not a statement it knows", async () => {
    const cookie = await signUp();
    const accountId = await openAccount(cookie, "current");
    const bytes = bytesOf("a;b\n1;2\n");

    const response = await upload("/api/imports/bank/preview", cookie, accountId, bytes);
    expect(response.status).toBe(400);
    expect(ErrorSchema.parse(await response.json()).error).toContain("tiliotteeksi");
  });
});

describe("POST /api/imports/bank/commit", () => {
  test("writes every row, and skips them all on a second import of the same file", async () => {
    const cookie = await signUp();
    const accountId = await openAccount(cookie, "current");

    const first = CommitSchema.parse(
      await (await upload("/api/imports/bank/commit", cookie, accountId)).json(),
    );
    expect(first.inserted).toBe(5);
    expect(first.skipped).toBe(0);
    // -42,15 + 2750,00 - 1000,00 + 12,34 - 59,90
    expect(await cashTotal(cookie, "2026-06-01")).toBe("1660.29");

    const second = CommitSchema.parse(
      await (await upload("/api/imports/bank/commit", cookie, accountId)).json(),
    );
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(5);
    // The balance is unchanged, which is the whole point of the archive id.
    expect(await cashTotal(cookie, "2026-06-01")).toBe("1660.29");
  });

  test("the whole file can be undone as one import", async () => {
    const cookie = await signUp();
    const accountId = await openAccount(cookie, "current");
    const committed = CommitSchema.parse(
      await (await upload("/api/imports/bank/commit", cookie, accountId)).json(),
    );

    const undone = await importRoutes["/api/imports/:id/undo"].POST(
      new Request(`http://x/api/imports/${committed.importId}/undo`, {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(undone.status).toBe(200);
    expect(await cashTotal(cookie, "2026-06-01")).toBe("0.00");
  });

  test("imports the readable rows and reports the one it could not read", async () => {
    const cookie = await signUp();
    const accountId = await openAccount(cookie, "current");
    const text = new TextDecoder().decode(await statement());
    const broken = text.replace('"2026-01-02";"2026-01-02"', '"2.1.2026";"2026-01-02"');

    const body = CommitSchema.parse(
      await (await upload("/api/imports/bank/commit", cookie, accountId, bytesOf(broken))).json(),
    );

    expect(body.inserted).toBe(4);
    expect(body.problems).toHaveLength(1);
  });
});

describe("POST /api/accounts/:id/balance", () => {
  const setBalance = (cookie: string, accountId: number, on: string, balance: string) =>
    bankImportRoutes["/api/accounts/:id/balance"].POST(
      new Request(`http://x/api/accounts/${accountId}/balance`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ on, balance }),
      }),
    );

  test("derives the balance the statements do not reach back to", async () => {
    const cookie = await signUp();
    const accountId = await openAccount(cookie, "current");
    await upload("/api/imports/bank/commit", cookie, accountId);

    // The bank says 9 000,00 today; the imported rows account for 1 660,29 of
    // it, so the account held 7 339,71 before the statement begins.
    const body = BalanceSchema.parse(
      await (await setBalance(cookie, accountId, "2026-06-01", "9000.00")).json(),
    );

    expect(body.derivedFromRowsEur).toBe("1660.29");
    expect(body.openingBalanceEur).toBe("7339.71");
    expect(body.openingBalanceDate).toBe("2025-08-31");
    expect(await cashTotal(cookie, "2026-06-01")).toBe("9000.00");
  });

  test("re-running it replaces the opening balance instead of stacking corrections", async () => {
    const cookie = await signUp();
    const accountId = await openAccount(cookie, "current");
    await upload("/api/imports/bank/commit", cookie, accountId);

    await setBalance(cookie, accountId, "2026-06-01", "9000.00");
    await setBalance(cookie, accountId, "2026-06-01", "11000.00");

    expect(await cashTotal(cookie, "2026-06-01")).toBe("11000.00");
  });

  test("reports agreement as a zero difference, which is the check", async () => {
    const cookie = await signUp();
    const accountId = await openAccount(cookie, "current");
    await upload("/api/imports/bank/commit", cookie, accountId);

    const body = BalanceSchema.parse(
      await (await setBalance(cookie, accountId, "2026-06-01", "1660.29")).json(),
    );
    expect(body.openingBalanceEur).toBe("0.00");
    expect(await cashTotal(cookie, "2026-06-01")).toBe("1660.29");
  });

  test("refuses someone else's account, as 404", async () => {
    const owner = await signUp();
    const stranger = await signUp();
    const accountId = await openAccount(owner, "current");

    const response = await setBalance(stranger, accountId, "2026-06-01", "100.00");
    expect(response.status).toBe(404);
  });
});

describe("a PDF statement", () => {
  const pdf = (): Promise<ArrayBuffer> =>
    Bun.file(`${import.meta.dir}/../import/fixtures/op-statement-sample.pdf`).arrayBuffer();

  test("is read, and says it was checked against its own printed balances", async () => {
    const cookie = await signUp();
    const accountId = await openAccount(cookie, "current");

    const body = PreviewSchema.parse(
      await (await upload("/api/imports/bank/preview", cookie, accountId, await pdf())).json(),
    );

    expect(body.rows).toBe(2);
    expect(body.verified).toBe(true);
    expect(body.openingBalanceEur).toBe("1500.00");
    expect(body.closingBalanceEur).toBe("1574.10");
  });

  test("brings its own opening balance, so nothing has to be typed in", async () => {
    const cookie = await signUp();
    const accountId = await openAccount(cookie, "current");

    const body = PdfCommitSchema.parse(
      await (await upload("/api/imports/bank/commit", cookie, accountId, await pdf())).json(),
    );

    expect(body.inserted).toBe(2);
    // 1 500,00 opening - 25,90 + 100,00 = 1 574,10, the printed closing balance.
    expect(body.reconciliation?.differenceEur).toBe("0.00");
    expect(await cashTotal(cookie, "2026-12-31")).toBe("1574.10");
  });

  test("re-importing it leaves the balance where it was", async () => {
    const cookie = await signUp();
    const accountId = await openAccount(cookie, "current");
    await upload("/api/imports/bank/commit", cookie, accountId, await pdf());

    const second = PdfCommitSchema.parse(
      await (await upload("/api/imports/bank/commit", cookie, accountId, await pdf())).json(),
    );

    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(2);
    expect(second.reconciliation?.differenceEur).toBe("0.00");
    expect(await cashTotal(cookie, "2026-12-31")).toBe("1574.10");
  });

  test("refuses one whose rows do not add up to its own closing balance", async () => {
    // A statement claiming a closing balance its rows cannot reach: exactly what
    // a mis-read layout produces, and the reason the check exists.
    const text = [
      "+100,00 Saldo 1.1.2026",
      "2.1.2026 −10,00 PKORTTIMAKSU 1 202601025UTZ00000001 J",
      "KAUPPA",
      "+500,00 Saldo 31.1.2026",
    ].join("\n");

    const { parseOpStatementText, verifyStatement } = await import("../import/bank-pdf");
    const check = verifyStatement(parseOpStatementText(text));
    expect(check.ok).toBe(false);
    expect(check.differenceEur).toBe(41_000n);
  });
});

describe("a PDF this app cannot read", () => {
  test("is refused with the reason, not as a generic server error", async () => {
    const cookie = await signUp();
    const accountId = await openAccount(cookie, "current");
    // A valid PDF that is not a statement: the parser's complaint has to reach
    // the owner, since "Palvelinvirhe" tells them nothing about what to do.
    const notAStatement = await Bun.file(
      `${import.meta.dir}/../import/fixtures/scanned-no-text.pdf`,
    ).arrayBuffer();

    const response = await upload("/api/imports/bank/preview", cookie, accountId, notAStatement);

    expect(response.status).toBe(400);
    expect(ErrorSchema.parse(await response.json()).error).toContain("ei sisällä tekstiä");
  });

  test("a PDF with text but no balances says which is missing", async () => {
    const { parseOpStatementText } = await import("../import/bank-pdf");

    // The same path the route takes, on text that has rows but no balance line.
    expect(() =>
      parseOpStatementText("29.8.2025 −13,61 PKORTTIMAKSU 1 202508 J\nKAUPPA\n"),
    ).toThrow(/alku- ja loppusaldoa/);
  });
});

describe("importing several statements for one account", () => {
  const statementPdf = (name: string): Promise<ArrayBuffer> =>
    Bun.file(`${import.meta.dir}/../import/fixtures/${name}`).arrayBuffer();

  // op-statement-earlier.pdf covers 31.12.2024 - 28.8.2025, opening 0,00 and
  // closing 1 500,00; op-statement-sample.pdf picks up exactly there and ends
  // at 1 574,10. Together they are one continuous history.
  const later = () => statementPdf("op-statement-sample.pdf");
  const earlier = () => statementPdf("op-statement-earlier.pdf");

  test("a later statement does not overwrite an opening balance that reaches further back", async () => {
    const cookie = await signUp();
    const accountId = await openAccount(cookie, "current");

    await upload("/api/imports/bank/commit", cookie, accountId, await earlier());
    const second = PdfCommitSchema.parse(
      await (await upload("/api/imports/bank/commit", cookie, accountId, await later())).json(),
    );

    // The 2024 opening still stands: replacing it with the later statement's
    // own opening while the earlier rows remain would count that period twice.
    expect(second.reconciliation?.openingBalanceWritten).toBe(false);
    expect(second.reconciliation?.openingBalanceDate).toBe("2024-12-31");
    expect(await cashTotal(cookie, "2026-12-31")).toBe("1574.10");
  });

  test("a statement reaching further back does replace it", async () => {
    const cookie = await signUp();
    const accountId = await openAccount(cookie, "current");

    await upload("/api/imports/bank/commit", cookie, accountId, await later());
    const second = PdfCommitSchema.parse(
      await (await upload("/api/imports/bank/commit", cookie, accountId, await earlier())).json(),
    );

    expect(second.reconciliation?.openingBalanceWritten).toBe(true);
    expect(second.reconciliation?.openingBalanceDate).toBe("2024-12-31");
    // Same total whichever order they arrive in, which is the point.
    expect(await cashTotal(cookie, "2026-12-31")).toBe("1574.10");
  });

  test("re-importing the same statement leaves the balance untouched", async () => {
    const cookie = await signUp();
    const accountId = await openAccount(cookie, "current");

    await upload("/api/imports/bank/commit", cookie, accountId, await earlier());
    await upload("/api/imports/bank/commit", cookie, accountId, await earlier());

    expect(await cashTotal(cookie, "2026-12-31")).toBe("1500.00");
  });
});

describe("a fixed-term deposit's maturity date", () => {
  const depositPdf = (): Promise<ArrayBuffer> =>
    Bun.file(`${import.meta.dir}/../import/fixtures/op-fixed-term-sample.pdf`).arrayBuffer();

  const accountRow = async (accountId: number) => {
    const { getDb } = await import("../db");
    const { accounts } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    return getDb().db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  };

  test("is taken from the statement onto an account that has none", async () => {
    const cookie = await signUp();
    const accountId = await openAccount(cookie, "fixed_term");

    const body = PdfCommitSchema.parse(
      await (
        await upload("/api/imports/bank/commit", cookie, accountId, await depositPdf())
      ).json(),
    );

    // The statement states it, so the owner does not have to type it again.
    expect(body.maturityDate).toBe("2027-02-01");
    expect((await accountRow(accountId))?.maturityDate).toBe("2027-02-01");
  });

  test("never overwrites one the owner already recorded, and reports the disagreement", async () => {
    const cookie = await signUp();
    const accountId = await openAccount(cookie, "fixed_term");
    await accountRoutes["/api/accounts/:id"].PATCH(
      new Request(`http://x/api/accounts/${accountId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ maturityDate: "2027-12-31" }),
      }),
    );

    const body = PdfCommitSchema.parse(
      await (
        await upload("/api/imports/bank/commit", cookie, accountId, await depositPdf())
      ).json(),
    );

    expect(body.maturityDate).toBe("2027-12-31");
    // A deposit whose stated term differs from the recorded one is worth
    // looking at, not silently adopting.
    expect(body.maturityConflict).toBe("2027-02-01");
    expect((await accountRow(accountId))?.maturityDate).toBe("2027-12-31");
  });

  test("is not written onto a current account, where it would mean nothing", async () => {
    const cookie = await signUp();
    const accountId = await openAccount(cookie, "current");

    const body = PdfCommitSchema.parse(
      await (
        await upload("/api/imports/bank/commit", cookie, accountId, await depositPdf())
      ).json(),
    );

    expect(body.maturityDate).toBeNull();
    expect((await accountRow(accountId))?.maturityDate).toBeNull();
  });

  test("makes the deposit's cash read as locked without any further input", async () => {
    const cookie = await signUp();
    const accountId = await openAccount(cookie, "fixed_term");
    await upload("/api/imports/bank/commit", cookie, accountId, await depositPdf());

    const cash = await portfolioRoutes["/api/cash"].GET(
      new Request("http://x/api/cash?on=2026-06-01", { headers: { cookie } }),
    );
    const body = z
      .object({ availableEur: z.string(), lockedEur: z.string() })
      .parse(await cash.json());

    expect(body.lockedEur).toBe("5000.00");
    expect(body.availableEur).toBe("0.00");
  });
});

describe("classifying an import's new merchants", () => {
  /**
   * SAFETY: the classifier reaches only `beta.messages.toolRunner`, which this
   * implements; nothing else of the SDK's surface is touched.
   */
  const replying = (text: string) =>
    ({
      beta: {
        messages: {
          toolRunner: () => ({
            async *[Symbol.asyncIterator]() {
              yield {
                id: "msg",
                type: "message",
                role: "assistant",
                model: "test",
                content: [{ type: "text", text, citations: null }],
                stop_reason: "end_turn",
                stop_sequence: null,
                container: null,
                context_management: null,
                diagnostics: null,
                stop_details: null,
                usage: {
                  input_tokens: 0,
                  output_tokens: 0,
                  cache_creation_input_tokens: null,
                  cache_read_input_tokens: null,
                  cache_creation: null,
                  server_tool_use: null,
                  service_tier: null,
                  fallback_credit: null,
                  inference_geo: null,
                  iterations: null,
                  output_tokens_details: null,
                  speed: null,
                },
              };
            },
          }),
        },
      },
    }) as Parameters<typeof setClassifierClient>[0];

  const ClassifiedSchema = z.object({
    classified: z
      .object({
        asked: z.number(),
        added: z.number(),
        rejected: z.number(),
        error: z.string().nullable(),
      })
      .nullable(),
  });

  test("teaches the rules a shop the file named, in one batch", async () => {
    setClassifierClient(
      replying('{"rules":[{"pattern":"ESIMERKKI VAKUUTUS","category":"vakuutukset"}]}'),
    );
    const cookie = await signUp();
    const accountId = await openAccount(cookie, "current");

    // Reading the rules is what seeds them for a new account; deleting before
    // that would match nothing and the seed would put the pattern straight back.
    await portfolioRoutes["/api/spending/rules"].GET(
      new Request("http://x/api/spending/rules", { headers: { cookie } }),
    );
    // The seed rules already know the word "VAKUUTUS", so it is removed first:
    // classification only ever runs on merchants no rule covers, and this is
    // what one looks like.
    await portfolioRoutes["/api/spending/rules"].DELETE(
      new Request("http://x/api/spending/rules?pattern=VAKUUTUS", {
        method: "DELETE",
        headers: { cookie },
      }),
    );

    const body = ClassifiedSchema.parse(
      await (await upload("/api/imports/bank/commit", cookie, accountId)).json(),
    );

    expect(body.classified?.added).toBeGreaterThan(0);
    expect(body.classified?.error).toBeNull();

    // ...and the rule holds for the next question about spending.
    const spending = await portfolioRoutes["/api/spending"].GET(
      new Request("http://x/api/spending?from=2025-01-01&to=2026-12-31&by=category", {
        headers: { cookie },
      }),
    );
    const groups = z
      .object({ groups: z.array(z.object({ key: z.string() })) })
      .parse(await spending.json());
    expect(groups.groups.some((group) => group.key === "vakuutukset")).toBe(true);

    setClassifierClient(null);
  });

  test("an import still succeeds when the classifier cannot be reached", async () => {
    // SAFETY: as with `replying` above -- one method, implemented here.
    setClassifierClient({
      beta: {
        messages: {
          toolRunner: () => ({
            // eslint-disable-next-line require-yield
            async *[Symbol.asyncIterator]() {
              throw new Error("upstream unavailable");
            },
          }),
        },
      },
    } as Parameters<typeof setClassifierClient>[0]);
    const cookie = await signUp();
    const accountId = await openAccount(cookie, "current");
    await portfolioRoutes["/api/spending/rules"].GET(
      new Request("http://x/api/spending/rules", { headers: { cookie } }),
    );
    await portfolioRoutes["/api/spending/rules"].DELETE(
      new Request("http://x/api/spending/rules?pattern=VAKUUTUS", {
        method: "DELETE",
        headers: { cookie },
      }),
    );

    const response = await upload("/api/imports/bank/commit", cookie, accountId);
    const body = ClassifiedSchema.parse(await response.json());

    // The rows are in; only the classification failed, and it says so.
    expect(response.status).toBe(201);
    expect(body.classified?.error).toBe("upstream unavailable");
    expect(await cashTotal(cookie, "2026-06-01")).toBe("1660.29");

    setClassifierClient(null);
  });
});
