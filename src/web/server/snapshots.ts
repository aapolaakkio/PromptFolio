import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  AccountQuery,
  adjustSnapshotRow,
  AdjustInput,
  createSnapshot,
  CreateSnapshot,
  deleteSnapshot,
  listSnapshots,
  PasteSnapshot,
  proposeFromCsv,
  proposeFromPaste,
  reconcileSnapshot,
  SnapshotQuery,
} from "../../server/snapshot/service.ts";
import { authed, readable } from "./guard.ts";

export const getSnapshots = createServerFn()
  .middleware([authed])
  .validator(AccountQuery)
  .handler(({ data, context }) => readable(() => listSnapshots(context.userId, data.accountId)));

export const saveSnapshot = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(CreateSnapshot)
  .handler(({ data, context }) => readable(() => createSnapshot(context.userId, data)));

export const getReconciliation = createServerFn()
  .middleware([authed])
  .validator(SnapshotQuery)
  .handler(({ data, context }) =>
    readable(() => reconcileSnapshot(context.userId, data.snapshotId)),
  );

export const proposeSnapshotFromCsv = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(z.instanceof(FormData))
  .handler(({ data, context }) => readable(() => proposeFromCsv(context.userId, data)));

export const proposeSnapshotFromPaste = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(PasteSnapshot)
  .handler(({ data, context }) => readable(() => proposeFromPaste(context.userId, data)));

export const removeSnapshot = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(SnapshotQuery)
  .handler(({ data, context }) => readable(() => deleteSnapshot(context.userId, data.snapshotId)));

export const adjustSnapshot = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(AdjustInput)
  .handler(({ data, context }) =>
    readable(() => adjustSnapshotRow(context.userId, data.snapshotId, data)),
  );
