import { HttpError } from "../errors.ts";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export type Upload = { file: File; accountId: number };

export const readUpload = (form: FormData): Upload => {
  const file = form.get("file");
  const accountIdRaw = form.get("accountId");
  if (!(file instanceof File)) throw new HttpError(400, "File is missing");
  if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, "File is too large (max 5 MB)");
  if (accountIdRaw === null || accountIdRaw instanceof File) {
    throw new HttpError(400, "Account is missing");
  }
  const accountId = Number(accountIdRaw);
  if (!Number.isInteger(accountId)) throw new HttpError(400, "Account is invalid");
  return { file, accountId };
};
