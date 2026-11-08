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
import { extractPages } from "./pdf-read.ts";
import { readBrokerRecordByRecipe } from "./recipe/broker-record.ts";
import { readBrokerTableByRecipe } from "./recipe/broker-table.ts";
import { DraftBody } from "./txn-draft.ts";

// Generous relative to any real OP paste seen so far (a year of activity is
// a few hundred lines): this is an abuse guard, not a realistic ceiling.
export const MAX_PASTE_CHARS = 2_000_000;

/**
 * Every known instrument, indexed two ways: by ISIN (Nordnet, and any
 * broker whose export carries one) and by name (OP's web-paste view, which
 * carries no ISIN at all -- see `mapRows`'s `knownNames` option). Both maps
 * are built from one query so `buildDraft`/`buildPasteDraft` never issue it
 * twice.
 */
const knownInstrumentMaps = async () => {
  const rows = await db
    .select({ isin: instruments.isin, name: instruments.name, id: instruments.id })
    .from(instruments)
    .all();
  return {
    // An instrument may have no ISIN at all -- a delisted share, or a temporary
    // line from a corporate action. Those are matched by name alone, exactly
    // like every row from OP's ISIN-less paste, so they are absent here rather
    // than keyed under a null nobody can look up.
    knownIsins: new Map(rows.flatMap((i) => (i.isin === null ? [] : [[i.isin, i.id] as const]))),
    knownNames: new Map(rows.map((i) => [i.name, i.id] as const)),
  };
};

/** A PDF announces itself in its first bytes; everything else is tried as CSV. */
const isPdf = (bytes: ArrayBuffer): boolean =>
  new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";

/** Injected by tests, so a PDF never reaches the real model. */
let readerClient: ChatClient | null = null;
export const _setReaderClient = (client: ChatClient | null): void => {
  readerClient = client;
};

/**
 * A broker PDF's text, read by a record recipe into the same draft a CSV
 * upload produces. Nothing here checks the result beyond the recipe's own
 * check -- the rest belongs to the review screen and `commitDraftBody`.
 */
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
    return run.draft;
  } catch (cause) {
    throw new HttpError(
      400,
      cause instanceof Error ? cause.message : "PDF-tiedostoa ei voitu lukea",
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
      : new HttpError(400, cause instanceof Error ? cause.message : "Tiedostoa ei voitu lukea");
  }

  // Refused, not split: importing rows from two accounts under one of them is
  // what made a real portfolio's returns unreproducible. The owner exports per
  // account instead -- and the message names the accounts so they know which.
  const portfolios = portfoliosNamed(run.rows, { columns: { portfolio: "portfolio" } });
  if (portfolios.length > 1) {
    throw new HttpError(
      400,
      `Tiedosto sisältää useamman salkun (${portfolios.join(", ")}). ` +
        "Vie tapahtumat erikseen kullekin tilille.",
    );
  }

  return { broker: "csv" as const, draft: run.draft, sha256 };
};

/**
 * A pasted import's body. Deliberately no trimming or normalising: the paste is
 * anchored on exact row separators and multi-space unit padding that either
 * would destroy.
 */
const PasteBody = z.object({
  text: z.string().min(1, "Liitettävä teksti puuttuu").max(MAX_PASTE_CHARS, "Liite on liian suuri"),
  accountId: z.number().int().positive(),
});

/**
 * A paste is a table when its first line splits into several columns and most
 * lines split the same way; otherwise every value sits on its own line, as
 * OP's web view copies.
 */
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

/**
 * Pasted transactions into the same draft a CSV upload produces, so they commit
 * the same way. Read by a recipe like every other import: a pasted table by a
 * table recipe, one value per line by a record recipe.
 */
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
    return { draft: run.draft, sha256: createHash("sha256").update(text).digest("hex") };
  } catch (cause) {
    throw cause instanceof HttpError
      ? cause
      : new HttpError(400, cause instanceof Error ? cause.message : "Liitettä ei voitu lukea");
  }
};

/**
 * Backfills a committed draft's instruments without delaying or failing the
 * response. The catch is a second layer: the call already isolates each
 * instrument's own failure.
 */
const fireBackfill = (draft: Draft): void => {
  void backfillCommittedInstruments(db, draft).catch((cause) => {
    console.error("Taustatäyttö tuonnin jälkeen epäonnistui odottamattomasti", cause);
  });
};

// A pasted-text import has no real filename; this constant labels the
// resulting `imports` row the same way for every paste.
const PASTE_FILENAME = "liite.txt";

// Preview and commit both re-parse the uploaded file (or re-parse the
// pasted text) from scratch. That is deliberate: no server-side draft state
// to expire, invalidate, or leak between users. The file is small
// (readUpload caps it at 5 MB, PasteBody caps text at 2 M characters) and
// the parse is cheap.

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
    // ISO 8601, like every other cross-boundary instant here: the frontend
    // formats it, this layer never pre-formats a date for a locale.
    createdAt: row.createdAt.toISOString(),
    inserted: row.insertedCount,
    skipped: row.skippedCount,
    undone: row.status === "undone",
  }));

export const previewUpload = async (userId: string, form: FormData) => {
  const { file, accountId } = readUpload(form);
  await assertAccountOwned(userId, accountId);
  const { broker, draft, sha256 } = await buildDraft(file, userId, accountId);
  return { broker, filename: file.name, sha256, ...draft };
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

/**
 * Commits the draft the owner reviewed in the preview -- edits included. The
 * file is not read again; the draft is what enters the ledger.
 *
 * A committed row lands on the account the request names: `insertRow` takes it
 * as a parameter and never reads a row's own `accountId`. The map below
 * normalises the draft to that same account so the draft and the ledger cannot
 * disagree -- a second layer, not the one doing the work.
 */
export const commitDraftBody = async (userId: string, body: z.infer<typeof CommitDraftBody>) => {
  const { accountId, filename, sha256, kind, draft } = CommitDraftBody.parse(body);
  await assertAccountOwned(userId, accountId);
  const owned: Draft = { ...draft, txns: draft.txns.map((txn) => ({ ...txn, accountId })) };
  const result = await commitDraft(db, { userId, accountId, filename, sha256, draft: owned, kind });
  fireBackfill(owned);
  return result;
};

/**
 * The upload-and-commit path `imports.tsx` still calls (Task 11 moves the
 * screen onto the preview-then-`commitDraftBody` flow above and this pair is
 * deleted). Kept working as a thin wrapper: build the same draft the preview
 * builds, then hand it to `commitDraftBody` so both paths share one check
 * and one commit.
 */
export const commitUpload = async (userId: string, form: FormData) => {
  const { file, accountId } = readUpload(form);
  // Checked here too, and not just inside commitDraftBody below: failing fast
  // on an account the caller cannot use must not first read the file, which
  // for a PDF means asking the model to read it.
  await assertAccountOwned(userId, accountId);
  const { broker, draft, sha256 } = await buildDraft(file, userId, accountId);
  return commitDraftBody(userId, {
    accountId,
    filename: file.name,
    sha256,
    kind: broker,
    draft,
  });
};

export const previewPaste = async (userId: string, body: z.infer<typeof PasteBody>) => {
  const { text, accountId } = PasteBody.parse(body);
  await assertAccountOwned(userId, accountId);
  const { draft, sha256 } = await buildPasteDraft(text, userId, accountId);
  return { broker: "paste", filename: PASTE_FILENAME, sha256, ...draft };
};

/**
 * The paste-and-commit path `imports.tsx` still calls (Task 11 moves the
 * screen onto the preview-then-`commitDraftBody` flow and this is deleted).
 * Kept working as a thin wrapper, same shape as `commitUpload` above.
 */
export const commitPaste = async (userId: string, body: z.infer<typeof PasteBody>) => {
  const { text, accountId } = PasteBody.parse(body);
  await assertAccountOwned(userId, accountId);
  const { draft, sha256 } = await buildPasteDraft(text, userId, accountId);
  return commitDraftBody(userId, {
    accountId,
    filename: PASTE_FILENAME,
    sha256,
    kind: "paste",
    draft,
  });
};

export const undo = (userId: string, importId: number) => undoImport(db, { userId, importId });

export { PasteBody };

export const UndoInput = z.object({ importId: z.number().int().positive() });
