import { readFile } from "node:fs/promises";

/** A file's text, as `readText(path)` returned it. */
export const readText = (path: string | URL): Promise<string> => readFile(path, "utf-8");

/** A file's bytes as an ArrayBuffer of exactly its length. The slice matters: Node reads into a pooled buffer, so a Buffer's `.buffer` is a larger arena and handing it to a parser passes neighbouring files' bytes with an offset nobody applied. */
export const readBytes = async (path: string | URL): Promise<ArrayBuffer> => {
  const buffer = await readFile(path);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
};
