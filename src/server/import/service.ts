import { createHash } from "node:crypto";
import { readUpload } from "./upload.ts";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.ts";
import { imports, instruments } from "../db/schema.ts";
import { HttpError } from "../errors.ts";
import { backfillCommittedInstruments } from "./backfill-on-commit.ts";
import { BROKER_CONFIGS, OP_WEB_PASTE } from "./brokers.ts";
import { commitDraft, undoImport } from "./commit.ts";
import { detectBroker, parseCsv } from "./csv.ts";
import { mapRows, type Draft } from "./map.ts";
import { portfoliosNamed } from "./portfolios.ts";
import { parseOpPaste } from "./op-paste.ts";
import type { BrokerCsvConfig } from "./types.ts";
import { assertAccountOwned } from "../accounts.ts";

const { db } = getDb();
// Generous relative to any real OP paste seen so far (a year of activity is
// a few hundred lines): this is an abuse guard, not a realistic ceiling.
const MAX_PASTE_CHARS = 2_000_000;

const probeHeaderLine = (bytes: ArrayBuffer, encoding: BrokerCsvConfig["encoding"]): string =>
  new TextDecoder(encoding).decode(bytes.slice(0, 4096)).split(/\r?\n/)[0] ?? "";

/**
 * Detects which broker produced this upload without assuming any
 * particular delimiter or encoding up front.
 *
 * `detectBroker` (Task 10) only checks whether a signature's headers are
 * present in an already-split array; it has no opinion on how that array
 * was produced. An earlier version of this function (matching the task
 * brief) always split the raw header line on a hardcoded `;` after
 * decoding it as UTF-8, regardless of which broker's config the bytes
 * actually need -- so a broker configured with a different delimiter or
 * encoding (Task 10's own brokers.ts comment flags this as expected to
 * happen: "If Nordnet's export turns out to be UTF-16LE and tab-delimited
 * ...") would never be detected, even though `parseCsv` would have parsed
 * it correctly once handed the right config.
 *
 * Instead, this tries every distinct (encoding, delimiter) pair that
 * `BROKER_CONFIGS` actually uses, decodes the header probe that way, and
 * asks `detectBroker` whether the resulting header array matches any
 * config. Each broker's own encoding/delimiter is only ever used to
 * decode headers for the signatures being checked in that pass, so a
 * mismatched pair can't accidentally "detect" the wrong broker.
 *
 * `configs` defaults to the real `BROKER_CONFIGS` and exists so
 * imports.test.ts can exercise this with a synthetic delimiter/encoding
 * pair neither shipped broker currently uses -- both Nordnet and OP
 * happen to share `;` and `utf-8` today, so a regression back to a
 * hardcoded probe would pass every test that only uses real fixtures.
 */
export const detectBrokerConfig = (
  bytes: ArrayBuffer,
  configs: readonly BrokerCsvConfig[] = BROKER_CONFIGS,
): BrokerCsvConfig | null => {
  const tried = new Set<string>();
  for (const candidate of configs) {
    const key = `${candidate.encoding}|${candidate.delimiter}`;
    if (tried.has(key)) continue;
    tried.add(key);
    const headers = probeHeaderLine(bytes, candidate.encoding)
      .split(candidate.delimiter)
      .map((h) => h.trim());
    const detected = detectBroker(headers);
    if (detected) return detected;
  }
  return null;
};

/**
 * Every known instrument, indexed two ways: by ISIN (Nordnet, and any
 * broker whose export carries one) and by name (OP's web-paste view, which
 * carries no ISIN at all -- see `mapRows`'s `knownNames` option). Both maps
 * are built from one query so `buildDraft`/`buildPasteDraft` never issue it
 * twice.
 */
const knownInstrumentMaps = () => {
  const rows = db
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

const buildDraft = async (file: File, accountId: number) => {
  const bytes = await file.arrayBuffer();
  const config = detectBrokerConfig(bytes);
  if (!config) throw new HttpError(400, "Tuntematon CSV-muoto: välittäjää ei tunnistettu");

  const { rows, problems: csvProblems } = parseCsv(bytes, config);

  // Refused, not split: importing rows from two accounts under one of them is
  // what made a real portfolio's returns unreproducible. The owner exports per
  // account instead -- and the message names the accounts so they know which.
  const portfolios = portfoliosNamed(rows, config);
  if (portfolios.length > 1) {
    throw new HttpError(
      400,
      `Tiedosto sisältää useamman salkun (${portfolios.join(", ")}). ` +
        "Vie tapahtumat erikseen kullekin tilille.",
    );
  }

  const { knownIsins, knownNames } = knownInstrumentMaps();
  const sha256 = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
  // Task 10's structural problems (bad column count, malformed quoting)
  // are merged into the draft here so the review screen gets one
  // line-ordered list of everything wrong with the file, instead of a
  // separate list the caller would have to stitch back together itself.
  return {
    config,
    draft: mapRows(rows, config, knownIsins, { accountId, csvProblems, knownNames }),
    sha256,
  };
};

/**
 * Reads and validates a pasted-text import request body. Deliberately no
 * `.trim()`/normalisation anywhere on `text`: OP's paste is anchored on
 * exact row separators (a line containing a single space) and multi-space
 * unit padding ("1,0453   kpl") that trimming or collapsing whitespace
 * would destroy -- see op-paste.ts's own module comment. The bytes travel
 * from `<textarea>` to here through one JSON round-trip and nothing else.
 */
const PasteBody = z.object({
  text: z.string().min(1, "Liitettävä teksti puuttuu").max(MAX_PASTE_CHARS, "Liite on liian suuri"),
  accountId: z.number().int().positive(),
});

/**
 * Parses OP's pasted web transaction view into the same `Draft` shape a CSV
 * upload produces, so it can go through the exact same `commitDraft`. There
 * is no `BrokerCsvConfig`/`detectBrokerConfig` step here -- the paste has no
 * delimiter and no header row for a signature match to run against (see
 * op-paste.ts) -- so `OP_WEB_PASTE` and `parseOpPaste` are used directly
 * instead of being routed through `buildDraft`'s CSV-shaped path.
 */
const buildPasteDraft = (text: string, accountId: number) => {
  let parsed: ReturnType<typeof parseOpPaste>;
  try {
    parsed = parseOpPaste(text);
  } catch (cause) {
    // parseOpPaste throws a plain Error (e.g. an unrecognised header block)
    // rather than an HttpError -- handle() would otherwise report it as a
    // generic 500, which is wrong for what is really a 400 (malformed
    // input), and would hide the parser's own descriptive Finnish message
    // from the client.
    throw new HttpError(
      400,
      cause instanceof Error ? cause.message : "OP-liitettä ei voitu jäsentää",
    );
  }
  const { knownIsins, knownNames } = knownInstrumentMaps();
  const sha256 = createHash("sha256").update(text).digest("hex");
  return {
    draft: mapRows(parsed.rows, OP_WEB_PASTE, knownIsins, {
      accountId,
      csvProblems: parsed.problems,
      knownNames,
    }),
    sha256,
  };
};

/**
 * Fires backfill for a just-committed draft's instruments without ever letting it delay or fail
 * the response a caller is waiting on -- see backfill-on-commit.ts's own doc comment for why
 * this is fire-and-forget rather than awaited. `backfillCommittedInstruments` already never
 * throws (it isolates every instrument's own failure internally), but the `.catch` here is a
 * second, independent layer for the same reason `runScheduledRefresh` (prices/refresh.ts) keeps
 * its own try/catch around each phase even though the function it calls is meant not to reject.
 */
const fireBackfill = (draft: Draft): void => {
  void backfillCommittedInstruments(db, draft).catch((cause) => {
    console.error("Taustatäyttö tuonnin jälkeen epäonnistui odottamattomasti", cause);
  });
};

// A pasted-text import has no real filename; this constant labels the
// resulting `imports` row the same way every OP paste produces, so the
// import history reads as "an OP paste", not a made-up per-request name.
const OP_PASTE_FILENAME = "op-liite.txt";

// Preview and commit both re-parse the uploaded file (or re-parse the
// pasted text) from scratch. That is deliberate: no server-side draft state
// to expire, invalidate, or leak between users. The file is small
// (readUpload caps it at 5 MB, PasteBody caps text at 2 M characters) and
// the parse is cheap.

export const listImports = (userId: string) =>
  db
    .select()
    .from(imports)
    .where(eq(imports.userId, userId))
    .orderBy(desc(imports.createdAt), desc(imports.id))
    .all()
    .map((row) => ({
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
  assertAccountOwned(userId, accountId);
  const { config, draft, sha256 } = await buildDraft(file, accountId);
  return { broker: config.broker, filename: file.name, sha256, ...draft };
};

export const commitUpload = async (userId: string, form: FormData) => {
  const { file, accountId } = readUpload(form);
  assertAccountOwned(userId, accountId);
  const { config, draft, sha256 } = await buildDraft(file, accountId);
  const result = await commitDraft(db, {
    userId,
    accountId,
    filename: file.name,
    sha256,
    draft,
    kind: config.broker === "nordnet" ? "csv_nordnet" : "csv_op",
  });
  fireBackfill(draft);
  return result;
};

export const previewPaste = (userId: string, body: z.infer<typeof PasteBody>) => {
  const { text, accountId } = PasteBody.parse(body);
  assertAccountOwned(userId, accountId);
  const { draft, sha256 } = buildPasteDraft(text, accountId);
  return { broker: OP_WEB_PASTE.broker, filename: OP_PASTE_FILENAME, sha256, ...draft };
};

export const commitPaste = async (userId: string, body: z.infer<typeof PasteBody>) => {
  const { text, accountId } = PasteBody.parse(body);
  assertAccountOwned(userId, accountId);
  const { draft, sha256 } = buildPasteDraft(text, accountId);
  const result = await commitDraft(db, {
    userId,
    accountId,
    filename: OP_PASTE_FILENAME,
    sha256,
    draft,
    kind: "csv_op",
  });
  fireBackfill(draft);
  return result;
};

export const undo = (userId: string, importId: number) => undoImport(db, { userId, importId });

export { PasteBody };

export const UndoInput = z.object({ importId: z.number().int().positive() });
