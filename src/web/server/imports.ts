import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  CommitDraftBody,
  commitDraftBody,
  listImports,
  PasteBody,
  previewPaste,
  previewUpload,
  undo,
  UndoInput,
} from "../../server/import/service.ts";
import { sortUploads } from "../../server/import/sort-service.ts";
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

/** Commits the draft the review screen produced (edits included) rather than re-reading the file. */
export const commitImportDraft = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(CommitDraftBody)
  .handler(({ data, context }) => readable(() => commitDraftBody(context.userId, data)));

export const previewOpPaste = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(PasteBody)
  .handler(({ data, context }) => readable(() => previewPaste(context.userId, data)));

export const undoImport = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(UndoInput)
  .handler(({ data, context }) => readable(() => undo(context.userId, data.importId)));

/** Works out what each dropped file is and which account it belongs to; stores nothing. */
export const sortImportFiles = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(upload)
  .handler(({ data, context }) => readable(() => sortUploads(context.userId, data)));
