import { listAccounts } from "../accounts.ts";
import { createClient, type ChatClient } from "../chat/runner.ts";
import { db } from "../db/index.ts";
import { HttpError } from "../errors.ts";
import { withModelTimeout } from "../instruments/find-page.ts";
import { extractPages, isPdf } from "./pdf-read.ts";
import { decodeHoldingsFile } from "./recipe/holdings-recipe.ts";
import {
  MAX_DROP_FILES,
  SAMPLE_LINES,
  FAILED,
  sortDocuments,
  unknownAll,
  type DocumentSample,
  type SortedDocument,
} from "./sort-documents.ts";
import { MAX_UPLOAD_BYTES } from "./upload.ts";

let sorterClient: ChatClient | null = null;
export const _setSorterClient = (client: ChatClient | null): void => {
  sorterClient = client;
};

const TOO_LARGE = "File is too large (max 5 MB)";
export const MAX_DROP_BYTES = 4 * MAX_UPLOAD_BYTES;
const SAMPLE_PDF_PAGES = 2;
const SAMPLE_TEXT_BYTES = 64 * 1024;
const PROBE_CHARS = 1024;
const MAX_JUNK_SHARE = 0.5;

/** NUL bytes or mostly replacement characters: an image, archive or wrong encoding, nothing worth sending. */
const looksBinary = (text: string): boolean => {
  const head = text.slice(0, PROBE_CHARS);
  if (head.includes("\u0000")) return true;
  const junk = head.split("\uFFFD").length - 1;
  return head.length > 0 && junk / head.length > MAX_JUNK_SHARE;
};

/** The first non-empty lines, found without splitting the whole text. */
const firstLines = (text: string): string[] => {
  const lines: string[] = [];
  let from = 0;
  while (lines.length < SAMPLE_LINES && from < text.length) {
    const end = text.indexOf("\n", from);
    const stop = end === -1 ? text.length : end;
    const line = text.slice(from, stop).replace(/\r$/, "");
    if (line.trim() !== "") lines.push(line);
    from = stop + 1;
  }
  return lines;
};

const textOf = async (file: File): Promise<string> => {
  const head = await file.slice(0, 5).arrayBuffer();
  if (isPdf(head)) {
    const pages = await extractPages(await file.arrayBuffer(), SAMPLE_PDF_PAGES);
    return pages.map((page) => page.text).join("\n");
  }
  return decodeHoldingsFile(new Uint8Array(await file.slice(0, SAMPLE_TEXT_BYTES).arrayBuffer()));
};

/** The text a model sees of one file; a file that cannot be read gives no lines, and so no guess. */
const sampleOf = async (file: File): Promise<DocumentSample> => {
  if (file.size > MAX_UPLOAD_BYTES) return { name: file.name, lines: [] };
  try {
    const text = await textOf(file);
    return { name: file.name, lines: looksBinary(text) ? [] : firstLines(text) };
  } catch {
    return { name: file.name, lines: [] };
  }
};

/** One file at a time, so a drop of many large PDFs never holds them all in memory together. */
const sampleAll = async (files: readonly File[]): Promise<DocumentSample[]> => {
  const samples: DocumentSample[] = [];
  for (const file of files) samples.push(await sampleOf(file));
  return samples;
};

const modelClient = (): ChatClient | null => {
  try {
    return withModelTimeout(sorterClient ?? createClient());
  } catch {
    return null;
  }
};

/** What each dropped file is and which of the owner's accounts it belongs to. Stores nothing: the preview and commit steps are the existing ones. */
export const sortUploads = async (userId: string, form: FormData): Promise<SortedDocument[]> => {
  const files = form.getAll("file").filter((entry): entry is File => entry instanceof File);
  if (files.length === 0) throw new HttpError(400, "File is missing");
  if (files.length > MAX_DROP_FILES) {
    throw new HttpError(400, `Drop at most ${MAX_DROP_FILES} files at once`);
  }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_DROP_BYTES) {
    throw new HttpError(
      400,
      `The files together are larger than ${MAX_DROP_BYTES / 1024 / 1024} MB; drop fewer at once`,
    );
  }
  const samples = await sampleAll(files);
  const owned = (await listAccounts(db, userId)).map(({ id, name, kind, broker, accountType }) => ({
    id,
    name,
    kind,
    broker,
    accountType,
  }));
  const client = modelClient();
  const sorted =
    client === null ? unknownAll(samples, FAILED) : await sortDocuments(client, owned, samples);
  return sorted.map((entry, index) =>
    (files[index]?.size ?? 0) > MAX_UPLOAD_BYTES
      ? { ...entry, kind: "unknown", accountId: null, reason: TOO_LARGE }
      : entry,
  );
};
