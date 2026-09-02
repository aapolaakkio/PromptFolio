import { readBytes } from "../files.ts";
import {
  CreateAccount,
  openAccount as openAccountRow,
  updateAccount,
  UpdateAccount,
} from "../accounts.ts";
import { cashView, spendingView } from "../views/portfolio.ts";
import { db } from "../db/index.ts";
import { removeRule, rulesFor } from "../spending/rules.ts";
import { beforeAll, describe, expect, test } from "vitest";
import { z, ZodError } from "zod";
import { HttpError } from "../errors.ts";
import { BankDraft } from "./bank-draft.ts";
import type { BankReading } from "./pdf-read.ts";

// Importing a statement writes several hundred cash rows at once, so these
// tests care about the three ways that goes wrong: onto the wrong kind of
// account, twice over, or without the balance that came before it.

type BankService = typeof import("./bank-service.ts");

let auth: ReturnType<(typeof import("../auth.ts"))["getAuth"]>;
let bank: BankService;
let setClassifierClient: BankService["_setClassifierClient"];
let setReaderClient: BankService["_setReaderClient"];
let undoImport: (typeof import("./service.ts"))["undo"];

beforeAll(async () => {
  auth = (await import("../auth.ts")).getAuth();
  bank = await import("./bank-service.ts");
  setClassifierClient = bank._setClassifierClient;
  setReaderClient = bank._setReaderClient;
  undoImport = (await import("./service.ts")).undo;
});

/** What the caller sees: a value, or the status and message a refusal carries. */
type Refusal = { error: string };
type Answer<T> = { status: number; body: T | Refusal };

const answer = async <T>(run: () => T | Promise<T>): Promise<Answer<T>> => {
  try {
    return { status: 200, body: await run() };
  } catch (cause) {
    if (cause instanceof HttpError) return { status: cause.status, body: { error: cause.message } };
    if (cause instanceof ZodError) {
      return { status: 400, body: { error: cause.issues[0]?.message ?? "Virheellinen pyyntö" } };
    }
    throw cause;
  }
};

const sessionCookieFrom = (response: Response): string => {
  const setCookie = response.headers.getSetCookie().find((c) => c.includes("session_token"));
  if (!setCookie) throw new Error("Response carried no session_token cookie");
  const nameValue = setCookie.split(";")[0];
  if (!nameValue) throw new Error("Malformed Set-Cookie header");
  return nameValue;
};

const signUp = async (): Promise<{ userId: string; cookie: string }> => {
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
  // SAFETY: a 200 from POST /sign-up/email always carries `{ user: { id } }`.
  const body = (await response.json()) as { user: { id: string } };
  return { userId: body.user.id, cookie: sessionCookieFrom(response) };
};

const ErrorSchema = z.object({ error: z.string() });
const CommitSchema = z.object({
  importId: z.number(),
  inserted: z.number(),
  skipped: z.number(),
  enriched: z.number(),
  problems: z.array(z.object({ line: z.number(), message: z.string() })),
});
// `draft` is the real `BankDraft` schema, not a hand-picked subset: `commit`
// below sends the parsed draft straight back into `commitBankDraft`, and a
// plain `z.object()` covering only the fields a test happens to read would
// strip the rest -- `counterparty`, `label`, `message`, `externalId` on a
// row, `maturityDate` on the statement -- which `commitBankDraft`'s strict
// `BankDraft` shape requires.
const PreviewSchema = z.object({
  bank: z.string(),
  filename: z.string(),
  sha256: z.string(),
  draft: BankDraft,
  check: z.object({ ok: z.boolean(), differenceEur: z.string() }).nullable(),
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

const BANK_TYPES = new Set(["current", "savings", "fixed_term"]);

const openAccount = async (userId: string, accountType: string | null): Promise<number> => {
  const body =
    accountType === null
      ? { name: "Nordnet", broker: "nordnet" }
      : {
          name: "OP käyttötili",
          broker: "op",
          kind: BANK_TYPES.has(accountType) ? "bank" : "brokerage",
          accountType,
        };
  return (await openAccountRow(db, userId, CreateAccount.parse(body))).id;
};

const statement = async (): Promise<ArrayBuffer> =>
  readBytes(`${import.meta.dirname}/../import/fixtures/op-bank-sample.csv`);

/**
 * SAFETY: `TextEncoder.encode` always returns a `Uint8Array` over a plain
 * `ArrayBuffer`, never a `SharedArrayBuffer`, which the DOM union cannot say.
 */
const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

const uploadForm = async (accountId: number, bytes?: ArrayBuffer): Promise<FormData> => {
  const form = new FormData();
  form.append("file", new File([bytes ?? (await statement())], "tapahtumat.csv"));
  form.append("accountId", String(accountId));
  return form;
};

const preview = async (userId: string, accountId: number, bytes?: ArrayBuffer) =>
  answer(async () => bank.previewBankStatement(userId, await uploadForm(accountId, bytes)));

const commit = async (userId: string, accountId: number, bytes?: ArrayBuffer) => {
  const previewed = await preview(userId, accountId, bytes);
  if (previewed.status !== 200) return previewed;
  const { filename, sha256, draft } = PreviewSchema.parse(previewed.body);
  return answer(() => bank.commitBankDraft(userId, { accountId, filename, sha256, draft }));
};

/** Never reaches Workers AI: the model's answer is scripted for each test. */
const reader = (reading: BankReading) => ({
  run: () => Promise.resolve({ text: JSON.stringify(reading), toolCalls: [] }),
});

/**
 * The model's scripted reading of `op-statement-sample.pdf`. Two rows whose
 * movement, added to the printed opening balance, reaches the printed closing
 * one -- the figures the tests below already assert (see "brings its own
 * opening balance"): 1500.00 - 25.90 + 100.00 = 1574.10.
 */
const sampleReading = {
  from: "2025-08-28",
  to: "2026-12-31",
  openingBalance: "1500.00",
  closingBalance: "1574.10",
  maturityDate: null,
  rows: [
    {
      date: "2025-09-01",
      amount: "-25.90",
      counterparty: "K-MARKET ESIMERKKI",
      message: "PKORTTIMAKSU",
      reference: "20250901001",
    },
    {
      date: "2025-10-01",
      amount: "100.00",
      counterparty: "TYÖNANTAJA OY",
      message: "PALKKA",
      reference: "20251001001",
    },
  ],
  problems: [],
};

/**
 * The scripted reading of `op-statement-earlier.pdf`: covers 2024-12-31 to
 * 2025-08-28, opening 0.00, closing 1500.00 -- the period `sampleReading`
 * picks up exactly where this one ends.
 */
const earlierReading = {
  from: "2024-12-31",
  to: "2025-08-28",
  openingBalance: "0.00",
  closingBalance: "1500.00",
  maturityDate: null,
  rows: [
    {
      date: "2025-01-15",
      amount: "1500.00",
      counterparty: "TYÖNANTAJA OY",
      message: "PALKKA",
      reference: "20250115001",
    },
  ],
  problems: [],
};

const cashTotal = async (userId: string, on: string): Promise<string> =>
  (await cashView(db, userId, on)).totalEur;

describe("POST /api/imports/bank/preview", () => {
  test("summarises the file without writing anything", async () => {
    const { userId } = await signUp();
    const accountId = await openAccount(userId, "current");

    const body = PreviewSchema.parse((await preview(userId, accountId)).body);

    expect(body.bank).toBe("op");
    expect(body.draft.rows.length).toBe(5);
    expect(body.draft.rows[0]?.date).toBe("2025-09-01");
    expect(body.draft.rows.at(-1)?.date).toBe("2026-01-02");
    expect(body.draft.rows[0]?.type).toBe("WITHDRAWAL");
    expect(body.draft.statement).toBeNull();
    expect(body.check).toBeNull();
    // Nothing committed.
    expect(await cashTotal(userId, "2026-06-01")).toBe("0.00");
  });

  test("refuses a brokerage account, where spending would corrupt the returns", async () => {
    const { userId } = await signUp();
    const brokerage = await openAccount(userId, "aot");

    const response = await preview(userId, brokerage);
    expect(response.status).toBe(400);
    expect(ErrorSchema.parse(response.body).error).toContain("pankkitilille");
  });

  test("refuses an unclassified account rather than guessing it is a bank one", async () => {
    const { userId } = await signUp();
    const unclassified = await openAccount(userId, null);

    expect((await preview(userId, unclassified)).status).toBe(400);
  });

  test("refuses a file that is not a statement it knows", async () => {
    const { userId } = await signUp();
    const accountId = await openAccount(userId, "current");
    const bytes = bytesOf("a;b\n1;2\n");

    const response = await preview(userId, accountId, bytes);
    expect(response.status).toBe(400);
    expect(ErrorSchema.parse(response.body).error).toContain("tiliotteeksi");
  });
});

describe("POST /api/imports/bank/commit", () => {
  test("writes every row, and skips them all on a second import of the same file", async () => {
    const { userId } = await signUp();
    const accountId = await openAccount(userId, "current");

    const first = CommitSchema.parse((await commit(userId, accountId)).body);
    expect(first.inserted).toBe(5);
    expect(first.skipped).toBe(0);
    // -42,15 + 2750,00 - 1000,00 + 12,34 - 59,90
    expect(await cashTotal(userId, "2026-06-01")).toBe("1660.29");

    const second = CommitSchema.parse((await commit(userId, accountId)).body);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(5);
    // The balance is unchanged, which is the whole point of the archive id.
    expect(await cashTotal(userId, "2026-06-01")).toBe("1660.29");
  });

  test("the whole file can be undone as one import", async () => {
    const { userId } = await signUp();
    const accountId = await openAccount(userId, "current");
    const committed = CommitSchema.parse((await commit(userId, accountId)).body);

    const undone = await answer(() => undoImport(userId, committed.importId));
    expect(undone.status).toBe(200);
    expect(await cashTotal(userId, "2026-06-01")).toBe("0.00");
  });

  test("imports the readable rows and reports the one it could not read", async () => {
    const { userId } = await signUp();
    const accountId = await openAccount(userId, "current");
    const text = new TextDecoder().decode(await statement());
    const broken = text.replace('"2026-01-02";"2026-01-02"', '"2.1.2026";"2026-01-02"');

    const body = CommitSchema.parse((await commit(userId, accountId, bytesOf(broken))).body);

    expect(body.inserted).toBe(4);
    expect(body.problems).toHaveLength(1);
  });
});

describe("POST /api/accounts/:id/balance", () => {
  const setBalance = (userId: string, accountId: number, on: string, balance: string) =>
    answer(() => bank.setAccountBalance(userId, { accountId, on, balance }));

  test("derives the balance the statements do not reach back to", async () => {
    const { userId } = await signUp();
    const accountId = await openAccount(userId, "current");
    await commit(userId, accountId);

    // The bank says 9 000,00 today; the imported rows account for 1 660,29 of
    // it, so the account held 7 339,71 before the statement begins.
    const body = BalanceSchema.parse(
      (await setBalance(userId, accountId, "2026-06-01", "9000.00")).body,
    );

    expect(body.derivedFromRowsEur).toBe("1660.29");
    expect(body.openingBalanceEur).toBe("7339.71");
    expect(body.openingBalanceDate).toBe("2025-08-31");
    expect(await cashTotal(userId, "2026-06-01")).toBe("9000.00");
  });

  test("re-running it replaces the opening balance instead of stacking corrections", async () => {
    const { userId } = await signUp();
    const accountId = await openAccount(userId, "current");
    await commit(userId, accountId);

    await setBalance(userId, accountId, "2026-06-01", "9000.00");
    await setBalance(userId, accountId, "2026-06-01", "11000.00");

    expect(await cashTotal(userId, "2026-06-01")).toBe("11000.00");
  });

  test("reports agreement as a zero difference, which is the check", async () => {
    const { userId } = await signUp();
    const accountId = await openAccount(userId, "current");
    await commit(userId, accountId);

    const body = BalanceSchema.parse(
      (await setBalance(userId, accountId, "2026-06-01", "1660.29")).body,
    );
    expect(body.openingBalanceEur).toBe("0.00");
    expect(await cashTotal(userId, "2026-06-01")).toBe("1660.29");
  });

  test("refuses someone else's account, as 404", async () => {
    const owner = await signUp();
    const stranger = await signUp();
    const accountId = await openAccount(owner.userId, "current");

    const response = await setBalance(stranger.cookie, accountId, "2026-06-01", "100.00");
    expect(response.status).toBe(404);
  });
});

describe("a PDF statement", () => {
  const pdf = (): Promise<ArrayBuffer> =>
    readBytes(`${import.meta.dirname}/../import/fixtures/op-statement-sample.pdf`);

  test("is read, and says it was checked against its own printed balances", async () => {
    setReaderClient(reader(sampleReading));
    const { userId } = await signUp();
    const accountId = await openAccount(userId, "current");

    const body = PreviewSchema.parse((await preview(userId, accountId, await pdf())).body);

    expect(body.draft.rows.length).toBe(2);
    expect(body.check).not.toBeNull();
    expect(body.draft.statement?.openingBalanceEur).toBe("1500.00");
    expect(body.draft.statement?.closingBalanceEur).toBe("1574.10");
  });

  test("brings its own opening balance, so nothing has to be typed in", async () => {
    setReaderClient(reader(sampleReading));
    const { userId } = await signUp();
    const accountId = await openAccount(userId, "current");

    const body = PdfCommitSchema.parse((await commit(userId, accountId, await pdf())).body);

    expect(body.inserted).toBe(2);
    // 1 500,00 opening - 25,90 + 100,00 = 1 574,10, the printed closing balance.
    expect(body.reconciliation?.differenceEur).toBe("0.00");
    expect(await cashTotal(userId, "2026-12-31")).toBe("1574.10");
  });

  test("re-importing it leaves the balance where it was", async () => {
    setReaderClient(reader(sampleReading));
    const { userId } = await signUp();
    const accountId = await openAccount(userId, "current");
    await commit(userId, accountId, await pdf());

    const second = PdfCommitSchema.parse((await commit(userId, accountId, await pdf())).body);

    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(2);
    expect(second.reconciliation?.differenceEur).toBe("0.00");
    expect(await cashTotal(userId, "2026-12-31")).toBe("1574.10");
  });

  test("an edited row is what gets imported, and the check runs on the edit", async () => {
    setReaderClient(reader(sampleReading));
    const { userId } = await signUp();
    const accountId = await openAccount(userId, "current");
    const previewed = PreviewSchema.parse((await preview(userId, accountId, await pdf())).body);
    const rows = previewed.draft.rows.map((row, index) =>
      index === 0 ? { ...row, amountEur: "-35.90" } : row,
    );

    const refused = await answer(() =>
      bank.commitBankDraft(userId, {
        accountId,
        filename: previewed.filename,
        sha256: previewed.sha256,
        draft: { ...previewed.draft, rows },
      }),
    );

    expect(refused.status).toBe(400);
    expect(ErrorSchema.parse(refused.body).error).toContain("10.00");
  });

  test("a draft with a field the schema does not know is refused", async () => {
    const { userId } = await signUp();
    const accountId = await openAccount(userId, "current");

    const response = await answer(() =>
      bank.commitBankDraft(userId, {
        accountId,
        filename: "x.pdf",
        sha256: "0",
        // A shape the type forbids reaching the parser, without a chained
        // assertion: `JSON.parse` returns `any` on its own.
        draft: JSON.parse('{"statement":null,"rows":[],"problems":[],"extra":1}'),
      }),
    );

    expect(response.status).toBe(400);
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

    const { parseOpStatementText, verifyStatement } = await import("../import/bank-pdf.ts");
    const check = verifyStatement(parseOpStatementText(text));
    expect(check.ok).toBe(false);
    expect(check.differenceEur).toBe(41_000n);
  });
});

describe("a PDF this app cannot read", () => {
  test("is refused with the reason, not as a generic server error", async () => {
    const { userId } = await signUp();
    const accountId = await openAccount(userId, "current");
    // A valid PDF that is not a statement: the parser's complaint has to reach
    // the owner, since "Palvelinvirhe" tells them nothing about what to do.
    const notAStatement = await readBytes(
      `${import.meta.dirname}/../import/fixtures/scanned-no-text.pdf`,
    );

    const response = await preview(userId, accountId, notAStatement);

    expect(response.status).toBe(400);
    expect(ErrorSchema.parse(response.body).error).toContain("ei sisällä tekstiä");
  });

  test("a PDF with text but no balances says which is missing", async () => {
    const { parseOpStatementText } = await import("../import/bank-pdf.ts");

    // The same path the route takes, on text that has rows but no balance line.
    expect(() =>
      parseOpStatementText("29.8.2025 −13,61 PKORTTIMAKSU 1 202508 J\nKAUPPA\n"),
    ).toThrow(/alku- ja loppusaldoa/);
  });
});

describe("importing several statements for one account", () => {
  const statementPdf = (name: string): Promise<ArrayBuffer> =>
    readBytes(`${import.meta.dirname}/../import/fixtures/${name}`);

  // op-statement-earlier.pdf covers 31.12.2024 - 28.8.2025, opening 0,00 and
  // closing 1 500,00; op-statement-sample.pdf picks up exactly there and ends
  // at 1 574,10. Together they are one continuous history.
  const later = () => statementPdf("op-statement-sample.pdf");
  const earlier = () => statementPdf("op-statement-earlier.pdf");

  test("a later statement does not overwrite an opening balance that reaches further back", async () => {
    const { userId } = await signUp();
    const accountId = await openAccount(userId, "current");

    setReaderClient(reader(earlierReading));
    await commit(userId, accountId, await earlier());
    setReaderClient(reader(sampleReading));
    const second = PdfCommitSchema.parse((await commit(userId, accountId, await later())).body);

    // The 2024 opening still stands: replacing it with the later statement's
    // own opening while the earlier rows remain would count that period twice.
    expect(second.reconciliation?.openingBalanceWritten).toBe(false);
    expect(second.reconciliation?.openingBalanceDate).toBe("2024-12-31");
    expect(await cashTotal(userId, "2026-12-31")).toBe("1574.10");
  });

  test("a statement reaching further back does replace it", async () => {
    const { userId } = await signUp();
    const accountId = await openAccount(userId, "current");

    setReaderClient(reader(sampleReading));
    await commit(userId, accountId, await later());
    setReaderClient(reader(earlierReading));
    const second = PdfCommitSchema.parse((await commit(userId, accountId, await earlier())).body);

    expect(second.reconciliation?.openingBalanceWritten).toBe(true);
    expect(second.reconciliation?.openingBalanceDate).toBe("2024-12-31");
    // Same total whichever order they arrive in, which is the point.
    expect(await cashTotal(userId, "2026-12-31")).toBe("1574.10");
  });

  test("re-importing the same statement leaves the balance untouched", async () => {
    const { userId } = await signUp();
    const accountId = await openAccount(userId, "current");

    setReaderClient(reader(earlierReading));
    await commit(userId, accountId, await earlier());
    await commit(userId, accountId, await earlier());

    expect(await cashTotal(userId, "2026-12-31")).toBe("1500.00");
  });
});

describe("a fixed-term deposit's maturity date", () => {
  const depositPdf = (): Promise<ArrayBuffer> =>
    readBytes(`${import.meta.dirname}/../import/fixtures/op-fixed-term-sample.pdf`);

  // A 5 000,00 deposit, so opening 0,00 plus this one row reaches the printed
  // closing balance, and the account's cash reads as exactly the amount the
  // "locked without any further input" test below asserts.
  const depositReading = {
    from: "2025-08-28",
    to: "2026-02-01",
    openingBalance: "0.00",
    closingBalance: "5000.00",
    maturityDate: "2027-02-01",
    rows: [
      {
        date: "2025-09-01",
        amount: "5000.00",
        counterparty: "",
        message: "TALLETUS",
        reference: "20250901fixedterm",
      },
    ],
    problems: [],
  };

  const accountRow = async (accountId: number) => {
    const { db } = await import("../db/index.ts");
    const { accounts } = await import("../db/schema.ts");
    const { eq } = await import("drizzle-orm");
    return db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  };

  test("is taken from the statement onto an account that has none", async () => {
    setReaderClient(reader(depositReading));
    const { userId } = await signUp();
    const accountId = await openAccount(userId, "fixed_term");

    const body = PdfCommitSchema.parse((await commit(userId, accountId, await depositPdf())).body);

    // The statement states it, so the owner does not have to type it again.
    expect(body.maturityDate).toBe("2027-02-01");
    expect((await accountRow(accountId))?.maturityDate).toBe("2027-02-01");
  });

  test("never overwrites one the owner already recorded, and reports the disagreement", async () => {
    setReaderClient(reader(depositReading));
    const { userId } = await signUp();
    const accountId = await openAccount(userId, "fixed_term");
    await updateAccount(db, userId, accountId, UpdateAccount.parse({ maturityDate: "2027-12-31" }));

    const body = PdfCommitSchema.parse((await commit(userId, accountId, await depositPdf())).body);

    expect(body.maturityDate).toBe("2027-12-31");
    // A deposit whose stated term differs from the recorded one is worth
    // looking at, not silently adopting.
    expect(body.maturityConflict).toBe("2027-02-01");
    expect((await accountRow(accountId))?.maturityDate).toBe("2027-12-31");
  });

  test("is not written onto a current account, where it would mean nothing", async () => {
    setReaderClient(reader(depositReading));
    const { userId } = await signUp();
    const accountId = await openAccount(userId, "current");

    const body = PdfCommitSchema.parse((await commit(userId, accountId, await depositPdf())).body);

    expect(body.maturityDate).toBeNull();
    expect((await accountRow(accountId))?.maturityDate).toBeNull();
  });

  test("makes the deposit's cash read as locked without any further input", async () => {
    setReaderClient(reader(depositReading));
    const { userId } = await signUp();
    const accountId = await openAccount(userId, "fixed_term");
    await commit(userId, accountId, await depositPdf());

    const body = await cashView(db, userId, "2026-06-01");

    expect(body.lockedEur).toBe("5000.00");
    expect(body.availableEur).toBe("0.00");
  });
});

describe("classifying an import's new merchants", () => {
  /** A model that answers with one fixed text, whatever it is asked. */
  const replying = (text: string): Parameters<typeof setClassifierClient>[0] => ({
    run: () => Promise.resolve({ text, toolCalls: [] }),
  });

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
    const { userId } = await signUp();
    const accountId = await openAccount(userId, "current");

    // Reading the rules is what seeds them for a new account; deleting before
    // that would match nothing and the seed would put the pattern straight back.
    await rulesFor(db, userId);
    // The seed rules already know the word "VAKUUTUS", so it is removed first:
    // classification only ever runs on merchants no rule covers, and this is
    // what one looks like.
    await removeRule(db, userId, "VAKUUTUS");

    const body = ClassifiedSchema.parse((await commit(userId, accountId)).body);

    expect(body.classified?.added).toBeGreaterThan(0);
    expect(body.classified?.error).toBeNull();

    // ...and the rule holds for the next question about spending.
    const spending = await spendingView(db, userId, "2025-01-01", "2026-12-31", "category", 15);
    expect(spending.groups.some((group) => group.key === "vakuutukset")).toBe(true);

    setClassifierClient(null);
  });

  test("an import still succeeds when the classifier cannot be reached", async () => {
    setClassifierClient({ run: () => Promise.reject(new Error("upstream unavailable")) });
    const { userId } = await signUp();
    const accountId = await openAccount(userId, "current");
    await rulesFor(db, userId);
    await removeRule(db, userId, "VAKUUTUS");

    const response = await commit(userId, accountId);
    const body = ClassifiedSchema.parse(response.body);

    // The rows are in; only the classification failed, and it says so.
    expect(response.status).toBe(200);
    expect(body.classified?.error).toBe("upstream unavailable");
    expect(await cashTotal(userId, "2026-06-01")).toBe("1660.29");

    setClassifierClient(null);
  });
});

describe("a statement that knows more than the one already imported", () => {
  const noteOf = async (externalId: string): Promise<string | null> => {
    const { db } = await import("../db/index.ts");
    const { transactions } = await import("../db/schema.ts");
    const { eq } = await import("drizzle-orm");
    const row = await db
      .select({ note: transactions.note })
      .from(transactions)
      .where(eq(transactions.externalId, externalId))
      .get();
    return row?.note ?? null;
  };

  test("fills in a payee the first file left blank, without doubling the row", async () => {
    const { userId } = await signUp();
    const accountId = await openAccount(userId, "current");

    // OP's CSV leaves the payee column empty for some card payments; its PDF
    // names the shop, and both carry the same archive id.
    const blank = bytesOf(
      [
        '"Kirjauspäivä";"Arvopäivä";"Määrä EUROA";"Laji";"Selitys";"Saaja/Maksaja";"Saajan tilinumero";"Saajan pankin BIC";"Viite";"Viesti";"Arkistointitunnus"',
        '"2025-09-10";"2025-09-10";"-7,27";"162";"PKORTTIMAKSU";"";"";"";"";"";"20250910ESIM00000009"',
        "",
      ].join("\n"),
    );
    const named = bytesOf(
      [
        '"Kirjauspäivä";"Arvopäivä";"Määrä EUROA";"Laji";"Selitys";"Saaja/Maksaja";"Saajan tilinumero";"Saajan pankin BIC";"Viite";"Viesti";"Arkistointitunnus"',
        '"2025-09-10";"2025-09-10";"-7,27";"162";"PKORTTIMAKSU";"K-MARKET ESIMERKKI";"";"";"";"";"20250910ESIM00000009"',
        "",
      ].join("\n"),
    );

    await commit(userId, accountId, blank);
    expect(await noteOf("20250910ESIM00000009")).toBe("PKORTTIMAKSU");

    const second = CommitSchema.parse((await commit(userId, accountId, named)).body);

    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.enriched).toBe(1);
    expect(await noteOf("20250910ESIM00000009")).toBe("PKORTTIMAKSU — K-MARKET ESIMERKKI");
    // The balance is untouched: this is the same row, better described.
    expect(await cashTotal(userId, "2026-06-01")).toBe("-7.27");
  });

  test("never overwrites a payee that is already there", async () => {
    const { userId } = await signUp();
    const accountId = await openAccount(userId, "current");
    await commit(userId, accountId);

    const second = CommitSchema.parse((await commit(userId, accountId)).body);

    expect(second.skipped).toBe(5);
    expect(second.enriched).toBe(0);
  });
});
