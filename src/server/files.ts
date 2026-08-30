import { readFile } from "node:fs/promises";

/** A file's text, as `readText(path)` returned it. */
export const readText = (path: string | URL): Promise<string> => readFile(path, "utf-8");

/**
 * A file's bytes as an ArrayBuffer of exactly that file's length.
 *
 * The slice is the whole point. Node reads into a pooled buffer, so a Buffer's
 * `.buffer` is usually a larger arena holding other reads as well, and handing
 * that straight to a parser passes it neighbouring files' bytes with an offset
 * nobody applied. `readBytes(path)` had no such trap, so nothing
 * that calls this was written to expect one.
 */
export const readBytes = async (path: string | URL): Promise<ArrayBuffer> => {
  const buffer = await readFile(path);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
};
