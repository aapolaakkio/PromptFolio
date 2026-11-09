import { createHash } from "node:crypto";
import { readUpload } from "./upload.ts";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.ts";
import { imports, instruments } from "../db/schema.ts";
import { HttpError } from "../errors.ts";
import { backfillCommittedInstruments } from "./backfill-on-commit.ts";
import { commitDraft, undoImport } from "./commit.ts";
import type { Draft } from "./map.ts";
import { portfoliosNamed } from "./portfolios.ts";
import { assertAccountOwned } from "../accounts.ts";
import { createClient, type ChatClient } from "../chat/runner.ts";
import { extractPages, isPdf } from "./pdf-read.ts";
import { readBrokerRecordByRecipe } from "./recipe/broker-record.ts";
import { readBrokerTableByRecipe } from "./recipe/broker-table.ts";
import { DraftBody } from "./txn-draft.ts";
import { createAdded, resolveUnknown } from "../instruments/auto-add.ts";
import { pageDeps, withModelTimeout, type PageDeps } from "../instruments/find-page.ts";
import type { FetchImpl } from "../prices/types.ts";
import { suggestRows } from "./suggest-rows.ts";
import { proposeActions, type CorporateProposal } from "./corporate-actions.ts";

export const MAX_PASTE_CHARS = 2_000_000;

const knownInstrumentMaps = async () => {
  const rows = await db
    .select({ isin: instruments.isin, name: instruments.name, id: instruments.id })
    .from(instruments)
    .all();
  return {
    knownIsins: new Map(rows.flatMap((i) => (i.isin === null ? [] : [[i.isin, i.id] as const]))),
    knownNames: new Map(rows.map((i) => [i.name, i.id] as const)),
  };
};

let readerClient: ChatClient | null = null;
export const _setReaderClient = (client: ChatClient | null): void => {
  readerClient = client;
};

let lookupFetch: FetchImpl | null = null;
export const _setLookupFetch = (fetchImpl: FetchImpl | null): void => {
  lookupFetch = fetchImpl;
};

let quoteSpacingMs: number | undefined;
export const _setQuoteSpacingMs = (ms: number | undefined): void => {
  quoteSpacingMs = ms;
};

let pageLookup: PageDeps | null | undefined;
export const _setPageLookup = (deps: PageDeps | null | undefined): void => {
  pageLookup = deps;
};

const withLookups = (draft: Draft): Promise<Draft> =>
  resolveUnknown(
    db,
    draft,
    lookupFetch ?? fetch,
    quoteSpacingMs,
    (pageLookup === undefined ? pageDeps() : pageLookup) ?? undefined,
  );

const buildPdfDraft = async (
  bytes: ArrayBuffer,
  userId: string,
  accountId: number,
): Promise<Draft> => {
  try {
    const pages = await extractPages(bytes);
    const text = pages.map((page) => page.text).join("\n");
    const known = await knownInstrumentMaps();
    const run = await readBrokerRecordByRecipe(
      text,
      userId,
      readerClient ?? createClient(),
      known,
      accountId,
    );
    return await withLookups(run.draft);
  } catch (cause) {
    throw new HttpError(
      400,
      cause instanceof Error ? cause.message : "The PDF file could not be read",
    );
  }
};

const buildDraft = async (file: File, userId: string, accountId: number) => {
  const bytes = await file.arrayBuffer();
  const sha256 = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");

  if (isPdf(bytes)) {
    return { broker: "pdf" as const, draft: await buildPdfDraft(bytes, userId, accountId), sha256 };
  }

  const known = await knownInstrumentMaps();
  let run: Awaited<ReturnType<typeof readBrokerTableByRecipe>>;
  try {
    run = await readBrokerTableByRecipe(
      bytes,
      userId,
      readerClient ?? createClient(),
      known,
      accountId,
    );
  } catch (cause) {
    throw cause instanceof HttpError
      ? cause
      : new HttpError(400, cause instanceof Error ? cause.message : "The file could not be read");
  }

  // Refused, not split: rows from two accounts under one made a real portfolio's returns unreproducible.
  const portfolios = portfoliosNamed(run.rows, { columns: { portfolio: "portfolio" } });
  if (portfolios.length > 1) {
    throw new HttpError(
      400,
      `The file contains more than one portfolio (${portfolios.join(", ")}). ` +
        "Export the transactions separately for each account.",
    );
  }

  return { broker: "csv" as const, draft: await withLookups(run.draft), sha256 };
};

const EXAMPLE_ROWS = 5;
const QUANTITY_SCALE = 1_000_000;

const rawTextOf = (problem: Draft["problems"][number]): string =>
  problem.rawLine ??
  Object.entries(problem.raw)
    .map(([key, value]) => `${key}: ${value}`)
    .join("; ");

const exampleOf = (txn: Draft["txns"][number]) => ({
  tradeDate: txn.tradeDate,
  type: txn.type,
  isin: txn.isin ?? "",
  quantityText: String(txn.quantity / QUANTITY_SCALE),
  amountEur: (txn.amount / 100).toFixed(2),
  feeEur: (txn.fee / 100).toFixed(2),
  currency: txn.currency,
});

/** A model that cannot be configured is the same as one that is down: the preview goes on without it. */
const previewClient = (): ChatClient | null => {
  try {
    return withModelTimeout(readerClient ?? createClient());
  } catch {
    return null;
  }
};

/** Corporate-action rows get checked booking proposals; the owner applies them on the preview. */
const corporateActionsOf = async (draft: Draft): Promise<readonly CorporateProposal[]> => {
  if (!draft.problems.some((problem) => problem.raw.type !== undefined)) return [];
  const client = previewClient();
  return client === null ? [] : proposeActions(client, draft.problems);
};

/** The model proposes values for rows the recipe could not read; the page shows them as unconfirmed. */
const withSuggestions = async (draft: Draft): Promise<Draft> => {
  const open = draft.problems.flatMap((problem, at) =>
    problem.ignored === true ? [] : [{ problem, at }],
  );
  if (open.length === 0) return draft;
  const client = previewClient();
  if (client === null) return draft;
  const found = await suggestRows(
    client,
    "broker",
    open.map(({ problem }) => ({
      line: problem.line,
      raw: rawTextOf(problem),
      message: problem.message,
    })),
    draft.txns.slice(0, EXAMPLE_ROWS).map(exampleOf),
  );
  const byPosition = new Map(
    open.flatMap(({ at }, k) => {
      const suggestion = found.get(k);
      return suggestion === undefined ? [] : [[at, suggestion] as const];
    }),
  );
  return {
    ...draft,
    problems: draft.problems.map((problem, at) => {
      const suggestion = byPosition.get(at);
      return suggestion === undefined ? problem : { ...problem, suggestion };
    }),
  };
};

const PasteBody = z.object({
  text: z
    .string()
    .min(1, "The pasted text is missing")
    .max(MAX_PASTE_CHARS, "The pasted text is too large"),
  accountId: z.number().int().positive(),
});

// ponytail: a column-count heuristic; let the model choose if a paste fools it.
const looksLikeTable = (text: string): boolean => {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const header = lines[0] ?? "";
  return ["\t", ";", ","].some((delimiter) => {
    const width = header.split(delimiter).length;
    if (width < 3) return false;
    const same = lines.filter((line) => line.split(delimiter).length === width).length;
    return same >= lines.length / 2;
  });
};

const buildPasteDraft = async (text: string, userId: string, accountId: number) => {
  const known = await knownInstrumentMaps();
  const client = readerClient ?? createClient();
  try {
    const run = looksLikeTable(text)
      ? await readBrokerTableByRecipe(
          new TextEncoder().encode(text).buffer,
          userId,
          client,
          known,
          accountId,
        )
      : await readBrokerRecordByRecipe(text, userId, client, known, accountId);
    return {
      draft: await withLookups(run.draft),
      sha256: createHash("sha256").update(text).digest("hex"),
    };
  } catch (cause) {
    throw cause instanceof HttpError
      ? cause
      : new HttpError(
          400,
          cause instanceof Error ? cause.message : "The pasted text could not be read",
        );
  }
};

const fireBackfill = (draft: Draft): void => {
  void backfillCommittedInstruments(db, draft).catch((cause) => {
    console.error("Backfill after import failed unexpectedly", cause);
  });
};

const PASTE_FILENAME = "paste.txt";

export const listImports = async (userId: string) =>
  (
    await db
      .select()
      .from(imports)
      .where(eq(imports.userId, userId))
      .orderBy(desc(imports.createdAt), desc(imports.id))
      .all()
  ).map((row) => ({
    id: row.id,
    kind: row.kind,
    filename: row.filename,
    createdAt: row.createdAt.toISOString(),
    inserted: row.insertedCount,
    skipped: row.skippedCount,
    undone: row.status === "undone",
  }));

export const previewUpload = async (userId: string, form: FormData) => {
  const { file, accountId } = readUpload(form);
  await assertAccountOwned(userId, accountId);
  const built = await buildDraft(file, userId, accountId);
  const { broker, sha256 } = built;
  const [draft, corporateActions] = await Promise.all([
    withSuggestions(built.draft),
    corporateActionsOf(built.draft),
  ]);
  return { broker, filename: file.name, sha256, ...draft, corporateActions };
};

export const CommitDraftBody = z
  .object({
    accountId: z.number().int().positive(),
    filename: z.string().min(1).max(255),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    kind: z.enum(["csv", "paste", "pdf"]),
    draft: DraftBody,
  })
  .strict();

/** Rows land on the account the request names. */
export const commitDraftBody = async (userId: string, body: z.infer<typeof CommitDraftBody>) => {
  const { accountId, filename, sha256, kind, draft } = CommitDraftBody.parse(body);
  await assertAccountOwned(userId, accountId);
  const owned = await createAdded(db, {
    ...draft,
    txns: draft.txns.map((txn) => ({ ...txn, accountId })),
    added: [],
  });
  const result = await commitDraft(db, { userId, accountId, filename, sha256, draft: owned, kind });
  fireBackfill(owned);
  return result;
};

export const previewPaste = async (userId: string, body: z.infer<typeof PasteBody>) => {
  const { text, accountId } = PasteBody.parse(body);
  await assertAccountOwned(userId, accountId);
  const built = await buildPasteDraft(text, userId, accountId);
  const [draft, corporateActions] = await Promise.all([
    withSuggestions(built.draft),
    corporateActionsOf(built.draft),
  ]);
  const { sha256 } = built;
  return { broker: "paste", filename: PASTE_FILENAME, sha256, ...draft, corporateActions };
};

export const undo = (userId: string, importId: number) => undoImport(db, { userId, importId });

export { PasteBody };
