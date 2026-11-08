import { HttpError } from "../errors.ts";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export type Upload = { file: File; accountId: number };

/** The file and account a multipart upload carries, or the refusal it earns. */
export const readUpload = (form: FormData): Upload => {
  const file = form.get("file");
  const accountIdRaw = form.get("accountId");
  if (!(file instanceof File)) throw new HttpError(400, "Tiedosto puuttuu");
  if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, "Tiedosto on liian suuri (max 5 MB)");
  if (accountIdRaw === null || accountIdRaw instanceof File) {
    throw new HttpError(400, "Tili puuttuu");
  }
  const accountId = Number(accountIdRaw);
  if (!Number.isInteger(accountId)) throw new HttpError(400, "Tili on virheellinen");
  return { file, accountId };
};
