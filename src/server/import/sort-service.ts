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
  sortDocuments,
  type DocumentSample,
  type SortedDocument,
} from "./sort-documents.ts";
import { MAX_UPLOAD_BYTES } from "./upload.ts";

let sorterClient: ChatClient | null = null;
export const _setSorterClient = (client: ChatClient | null): void => {
  sorterClient = client;
};

const TOO_LARGE = "File is too large (max 5 MB)";

const firstLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(0, SAMPLE_LINES);

/** The text a model sees of one file; a file that cannot be read is sorted by its name alone. */
const sampleOf = async (file: File): Promise<DocumentSample> => {
  if (file.size > MAX_UPLOAD_BYTES) return { name: file.name, lines: [] };
  const bytes = await file.arrayBuffer();
  try {
    const text = isPdf(bytes)
      ? (await extractPages(bytes)).map((page) => page.text).join("\n")
      : decodeHoldingsFile(new Uint8Array(bytes));
    return { name: file.name, lines: firstLines(text) };
  } catch {
    return { name: file.name, lines: [] };
  }
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
  const samples = await Promise.all(files.map(sampleOf));
  const owned = (await listAccounts(db, userId)).map(({ id, name, kind, broker, accountType }) => ({
    id,
    name,
    kind,
    broker,
    accountType,
  }));
  const client = modelClient();
  const sorted =
    client === null
      ? samples.map((sample) => ({
          name: sample.name,
          kind: "unknown" as const,
          accountId: null,
          reason: "Could not be sorted automatically",
        }))
      : await sortDocuments(client, owned, samples);
  return sorted.map((entry, index) =>
    (files[index]?.size ?? 0) > MAX_UPLOAD_BYTES
      ? { ...entry, kind: "unknown", accountId: null, reason: TOO_LARGE }
      : entry,
  );
};
