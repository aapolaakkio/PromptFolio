import { inflateSync } from "node:zlib";

/**
 * Pulls the readable text out of a PDF, decoding subset fonts through their own
 * `ToUnicode` maps.
 *
 * The spec's §5.2 rule is text layer first, and both brokers' statements have
 * one -- but they are not equally easy. OP draws its text in a standard font,
 * so the literal strings are readable as they stand. Nordnet embeds subset
 * fonts and draws two-byte glyph codes, which come out as gibberish unless each
 * font's `ToUnicode` map is applied. Both are handled here; neither needs a
 * dependency or a model.
 *
 * Still deliberately not a full PDF parser. It does not follow object streams
 * (`/ObjStm`), inherited page resources, or `Encoding` differences on simple
 * fonts, and it reads only literal `(...)` strings, not hex `<...>` ones. A
 * caller that gets no runs must treat the file as having no text layer rather
 * than as an empty document.
 */

/**
 * One JavaScript code unit per byte.
 *
 * Not `TextDecoder("latin1")`: the WHATWG encoding standard aliases that name to
 * windows-1252, which rewrites bytes 0x80-0x9F into typographic characters --
 * byte 0x99 becomes U+2122. In prose that is invisible; in a PDF's glyph codes
 * it silently corrupts every code above 127, which is exactly what made a real
 * Nordnet statement decode to "Vuosytnvto" instead of "Vuosiyhteenveto".
 */
const binary = (bytes: Uint8Array): string => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return out;
};

type PdfObject = { readonly dict: string; readonly stream: Uint8Array | null };
type Font = { readonly twoByte: boolean; readonly cmap: Map<number, string> };

/** Every `n 0 obj ... endobj`, with its raw stream bytes when it has one. */
const readObjects = (bytes: Uint8Array, raw: string): Map<number, PdfObject> => {
  const objects = new Map<number, PdfObject>();
  for (const match of raw.matchAll(/(\d+)\s+0\s+obj/g)) {
    const bodyStart = match.index + match[0].length;
    const bodyEnd = raw.indexOf("endobj", bodyStart);
    if (bodyEnd < 0) continue;

    const body = raw.slice(bodyStart, bodyEnd);
    const streamStart = /stream\r?\n/.exec(body);
    if (!streamStart) {
      objects.set(Number(match[1]), { dict: body, stream: null });
      continue;
    }
    const streamEnd = body.indexOf("endstream", streamStart.index);
    objects.set(Number(match[1]), {
      dict: body.slice(0, streamStart.index),
      stream:
        streamEnd > 0
          ? bytes.slice(
              bodyStart + streamStart.index + streamStart[0].length,
              bodyStart + streamEnd,
            )
          : null,
    });
  }
  return objects;
};

const inflate = (object: PdfObject): string | null => {
  if (!object.stream) return null;
  try {
    return binary(inflateSync(object.stream));
  } catch {
    // Not Flate-compressed, or not compressed at all. An uncompressed content
    // stream is still readable; a font program or an image is not, and falls
    // out later when nothing in it looks like text.
    return binary(object.stream);
  }
};

/** UTF-16BE hex, as `ToUnicode` destinations are written. */
const fromHex = (hex: string): string => {
  let out = "";
  for (let i = 0; i + 4 <= hex.length; i += 4)
    out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return out || String.fromCodePoint(parseInt(hex, 16));
};

/** A font's `ToUnicode` CMap: glyph code to the character it draws. */
const parseCmap = (text: string): Map<number, string> => {
  const map = new Map<number, string>();

  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(pair[1]!, 16), fromHex(pair[2]!));
    }
  }

  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    // <lo> <hi> <dstStart>
    for (const range of block[1]!.matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g,
    )) {
      const lo = parseInt(range[1]!, 16);
      const hi = parseInt(range[2]!, 16);
      const dst = parseInt(range[3]!, 16);
      for (let code = lo; code <= hi; code++)
        map.set(code, String.fromCodePoint(dst + (code - lo)));
    }
    // <lo> <hi> [ <dst> <dst> ... ]
    for (const range of block[1]!.matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g,
    )) {
      const lo = parseInt(range[1]!, 16);
      [...range[3]!.matchAll(/<([0-9a-fA-F]+)>/g)].forEach((dst, index) => {
        map.set(lo + index, fromHex(dst[1]!));
      });
    }
  }
  return map;
};

/**
 * PDF literal-string escapes, including the octal form that carries raw bytes.
 * Leaving `\303` as four characters misaligns every two-byte glyph code after
 * it, which corrupts the rest of the string rather than one character of it.
 */
const unescape = (body: string): string => {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      out += body[i];
      continue;
    }
    const next = body[++i];
    if (next === undefined) break;
    if (next >= "0" && next <= "7") {
      let octal = next;
      while (
        octal.length < 3 &&
        body[i + 1] !== undefined &&
        body[i + 1]! >= "0" &&
        body[i + 1]! <= "7"
      ) {
        octal += body[++i];
      }
      out += String.fromCharCode(parseInt(octal, 8));
      continue;
    }
    out +=
      next === "n"
        ? "\n"
        : next === "r"
          ? "\r"
          : next === "t"
            ? "\t"
            : next === "b"
              ? "\b"
              : next === "f"
                ? "\f"
                : next;
  }
  return out;
};

export const extractPdfTextRuns = (bytes: Uint8Array): string[] => {
  const raw = binary(bytes);
  const objects = readObjects(bytes, raw);

  const fontFor = (reference: string): Font | undefined => {
    const font = objects.get(Number(reference));
    if (!font) return undefined;
    const toUnicode = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(font.dict);
    const cmapObject = toUnicode ? objects.get(Number(toUnicode[1]!)) : undefined;
    const cmapText = cmapObject ? inflate(cmapObject) : null;
    return {
      twoByte: /\/Subtype\s*\/Type0/.test(font.dict),
      cmap: cmapText ? parseCmap(cmapText) : new Map(),
    };
  };

  const runs: string[] = [];
  const pages = [...objects.values()].filter((object) => /\/Type\s*\/Page\b/.test(object.dict));

  // A page's fonts are resolved per page: subset fonts are embedded per page, so
  // /F1 on the second page is a different font, with a different CMap, from /F1
  // on the first.
  for (const page of pages) {
    const fonts = new Map<string, Font>();
    const fontDict = /\/Font\s*<<([\s\S]*?)>>/.exec(page.dict);
    if (fontDict) {
      for (const entry of fontDict[1]!.matchAll(/\/([A-Za-z0-9_+.-]+)\s+(\d+)\s+0\s+R/g)) {
        const font = fontFor(entry[2]!);
        if (font) fonts.set(entry[1]!, font);
      }
    }

    for (const reference of page.dict.matchAll(/\/Contents\s+(\d+)\s+0\s+R/g)) {
      const content = objects.get(Number(reference[1]!));
      const text = content ? inflate(content) : null;
      if (text === null) continue;

      let active: Font | undefined;
      const token = /\/([A-Za-z0-9_+.-]+)\s+[\d.]+\s+Tf|\(((?:[^()\\]|\\.)*)\)/g;
      let match: RegExpExecArray | null;
      while ((match = token.exec(text)) !== null) {
        if (match[1] !== undefined) {
          active = fonts.get(match[1]);
          continue;
        }
        const body = unescape(match[2] ?? "");
        if (!active?.twoByte) {
          if (body.trim() !== "") runs.push(body);
          continue;
        }
        let decoded = "";
        for (let i = 0; i + 1 < body.length; i += 2) {
          decoded += active.cmap.get((body.charCodeAt(i) << 8) | body.charCodeAt(i + 1)) ?? "";
        }
        if (decoded.trim() !== "") runs.push(decoded);
      }
    }
  }
  return runs;
};
