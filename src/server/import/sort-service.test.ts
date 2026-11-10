import { beforeAll, describe, expect, test } from "vitest";

import { openAccount } from "../accounts.ts";
import { CreateAccount } from "../action-inputs.ts";
import type { ChatClient, TurnParams } from "../chat/runner.ts";
import { db } from "../db/index.ts";
import { HttpError } from "../errors.ts";
import { MAX_DROP_FILES } from "./sort-documents.ts";
import { MAX_UPLOAD_BYTES } from "./upload.ts";

let service: typeof import("./sort-service.ts");
let bank: typeof import("./bank-service.ts");
let auth: ReturnType<(typeof import("../auth.ts"))["getAuth"]>;

beforeAll(async () => {
  auth = (await import("../auth.ts")).getAuth();
  service = await import("./sort-service.ts");
  bank = await import("./bank-service.ts");
});

const signUp = async (): Promise<string> => {
  const response = await auth.handler(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Test User",
        email: `sort-${crypto.randomUUID()}@example.com`,
        password: "correct horse battery staple",
      }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed with status ${response.status}`);
  // SAFETY: the body has the shape the route returns.
  return ((await response.json()) as { user: { id: string } }).user.id;
};

const scripted = (text: (asked: TurnParams) => string) => {
  const asked: TurnParams[] = [];
  const client: ChatClient = {
    run: async (params) => {
      asked.push(params);
      return { text: text(params), toolCalls: [] };
    },
  };
  return { client, asked };
};

const formOf = (...names: string[]): FormData => {
  const form = new FormData();
  for (const name of names) form.append("file", new File(["Kirjauspäivä;Määrä\n1;2"], name));
  return form;
};

describe("sortUploads", () => {
  test("sends only account descriptors, and clears an account the caller does not own", async () => {
    const owner = await signUp();
    const other = await signUp();
    const mine = await openAccount(
      db,
      owner,
      CreateAccount.parse({ name: "My bank", broker: "op", kind: "bank", accountType: "current" }),
    );
    const theirs = await openAccount(
      db,
      other,
      CreateAccount.parse({
        name: "Secret bank",
        broker: "op",
        kind: "bank",
        accountType: "current",
      }),
    );
    await bank.setAccountBalance(owner, {
      accountId: mine.id,
      on: "2024-01-31",
      balance: "4321.99",
    });
    const { client, asked } = scripted(() =>
      JSON.stringify({
        files: [
          { index: 0, kind: "bank-statement", accountId: theirs.id, reason: "stolen" },
          { index: 1, kind: "bank-statement", accountId: mine.id, reason: "columns" },
        ],
      }),
    );
    service._setSorterClient(client);

    const sorted = await service.sortUploads(owner, formOf("a.csv", "b.csv"));

    expect(sorted.map((s) => s.accountId)).toEqual([null, mine.id]);
    const prompt = (asked[0]?.messages ?? []).map((m) => m.content).join("\n");
    expect(prompt).toContain("My bank");
    expect(prompt).not.toContain("4321");
    expect(prompt).not.toContain("Secret bank");
    expect(asked[0]?.tools.map((tool) => tool.name)).not.toContain("web_search");
    service._setSorterClient(null);
  });

  test("refuses an empty drop and more than the file limit", async () => {
    const owner = await signUp();
    await expect(service.sortUploads(owner, new FormData())).rejects.toBeInstanceOf(HttpError);
    const many = formOf(...Array.from({ length: MAX_DROP_FILES + 1 }, (_, i) => `f${i}.csv`));
    await expect(service.sortUploads(owner, many)).rejects.toMatchObject({ status: 400 });
  });

  test("a model that throws leaves every file unknown", async () => {
    const owner = await signUp();
    service._setSorterClient({
      run: () => Promise.reject(new Error("down")),
    });
    const sorted = await service.sortUploads(owner, formOf("a.csv"));
    expect(sorted).toMatchObject([{ kind: "unknown", accountId: null }]);
    service._setSorterClient(null);
  });

  test("refuses a drop whose files together exceed the total cap", async () => {
    const owner = await signUp();
    const form = new FormData();
    for (const name of ["a.csv", "b.csv", "c.csv", "d.csv", "e.csv"]) {
      form.append("file", new File([new Uint8Array(MAX_UPLOAD_BYTES)], name));
    }
    await expect(service.sortUploads(owner, form)).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("20 MB"),
    });
  });

  test("sends at most 60 lines of a long file", async () => {
    const owner = await signUp();
    const { client, asked } = scripted(() => JSON.stringify({ files: [] }));
    service._setSorterClient(client);
    const text = Array.from({ length: 5000 }, (_, i) => `row ${i};x`).join("\n");
    const form = new FormData();
    form.append("file", new File([text], "long.csv"));
    await service.sortUploads(owner, form);
    const sent = JSON.parse(asked[0]!.messages[1]!.content);
    expect(sent.files[0].lines).toHaveLength(60);
    service._setSorterClient(null);
  });

  test("a binary file sends no lines and stays unknown", async () => {
    const owner = await signUp();
    const mine = await openAccount(
      db,
      owner,
      CreateAccount.parse({ name: "Bank", broker: "op", kind: "bank", accountType: "current" }),
    );
    const { client, asked } = scripted(() =>
      JSON.stringify({
        files: [{ index: 0, kind: "bank-statement", accountId: mine.id, reason: "name" }],
      }),
    );
    service._setSorterClient(client);
    const form = new FormData();
    form.append("file", new File([new Uint8Array([0, 1, 2, 0, 255, 0, 7])], "tiliote.csv"));
    const sorted = await service.sortUploads(owner, form);
    expect(sorted).toMatchObject([{ kind: "unknown", accountId: null }]);
    expect(asked).toHaveLength(0);
    service._setSorterClient(null);
  });
});
