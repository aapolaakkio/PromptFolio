import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  CommitDraftBody,
  commitDraftBody,
  commitPaste,
  commitUpload,
  listImports,
  PasteBody,
  previewPaste,
  previewUpload,
  undo,
  UndoInput,
} from "../../server/import/service.ts";
import { authed, readable } from "./guard.ts";

// An upload travels as multipart; the fields inside are checked server-side.
const upload = z.instanceof(FormData);

export const getImports = createServerFn()
  .middleware([authed])
  .handler(({ context }) => readable(() => listImports(context.userId)));

export const previewImport = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(upload)
  .handler(({ data, context }) => readable(() => previewUpload(context.userId, data)));

export const commitImport = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(upload)
  .handler(({ data, context }) => readable(() => commitUpload(context.userId, data)));

/**
 * Commits the draft the review screen produced (edits included), rather than
 * re-reading the file. `imports.tsx` moves onto this in Task 11, replacing
 * `commitImport` and `commitOpPaste` above -- both of which stay as they are
 * until then.
 */
export const commitImportDraft = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(CommitDraftBody)
  .handler(({ data, context }) => readable(() => commitDraftBody(context.userId, data)));

export const previewOpPaste = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(PasteBody)
  .handler(({ data, context }) => readable(() => previewPaste(context.userId, data)));

export const commitOpPaste = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(PasteBody)
  .handler(({ data, context }) => readable(() => commitPaste(context.userId, data)));

export const undoImport = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(UndoInput)
  .handler(({ data, context }) => readable(() => undo(context.userId, data.importId)));
