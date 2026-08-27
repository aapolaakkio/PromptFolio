import { test, expect } from "bun:test";
import { ApiError, apiGet, apiPost, apiUpload } from "./api";

test("apiGet returns the parsed JSON body on a 2xx response", async () => {
  const stub = async () => Response.json({ holdings: [] }, { status: 200 });
  const body = await apiGet<{ holdings: unknown[] }>("/api/holdings", stub);
  expect(body).toEqual({ holdings: [] });
});

/** `instanceof` narrows `cause` to ApiError with no assertion needed. */
const expectApiError = (cause: unknown): ApiError => {
  if (!(cause instanceof ApiError)) throw new Error("expected an ApiError");
  return cause;
};

test("apiGet throws ApiError with the server's Finnish message on a non-2xx response", async () => {
  const stub = async () => Response.json({ error: "Kirjautuminen vaaditaan" }, { status: 401 });
  await expect(apiGet("/api/accounts", stub)).rejects.toThrow(ApiError);
  try {
    await apiGet("/api/accounts", stub);
    throw new Error("expected apiGet to reject");
  } catch (cause) {
    const error = expectApiError(cause);
    expect(error.status).toBe(401);
    expect(error.message).toBe("Kirjautuminen vaaditaan");
    expect(error.name).toBe("ApiError");
  }
});

test("apiGet falls back to a generic message when the error body has no `error` string", async () => {
  const stub = async () => Response.json({ unrelated: true }, { status: 500 });
  try {
    await apiGet("/api/holdings", stub);
    throw new Error("expected apiGet to reject");
  } catch (cause) {
    expect(expectApiError(cause).message).toBe("Virhe 500");
  }
});

test("apiGet falls back to a read-failure message when a non-2xx body is not valid JSON", async () => {
  const stub = async () => new Response("<html>not json</html>", { status: 502 });
  try {
    await apiGet("/api/holdings", stub);
    throw new Error("expected apiGet to reject");
  } catch (cause) {
    expect(expectApiError(cause).message).toBe("Vastausta ei voitu lukea");
  }
});

test("apiGet returns the read-failure fallback body when a 2xx response is not valid JSON", async () => {
  const stub = async () => new Response("<html>not json</html>", { status: 200 });
  const body = await apiGet<{ error: string }>("/api/holdings", stub);
  expect(body).toEqual({ error: "Vastausta ei voitu lukea" });
});

test("apiPost sends a JSON body with credentials and the right headers", async () => {
  let seenInit: RequestInit | undefined;
  const stub = async (_path: string | URL | Request, init?: RequestInit) => {
    seenInit = init;
    return Response.json({ ok: true }, { status: 200 });
  };
  const body = await apiPost<{ ok: boolean }, { name: string }>(
    "/api/accounts",
    { name: "Nordnet" },
    stub,
  );
  expect(body).toEqual({ ok: true });
  expect(seenInit?.method).toBe("POST");
  expect(seenInit?.credentials).toBe("include");
  expect(seenInit?.body).toBe(JSON.stringify({ name: "Nordnet" }));
  expect(new Headers(seenInit?.headers).get("content-type")).toBe("application/json");
});

test("apiPost surfaces a server-side validation error", async () => {
  const stub = async () => Response.json({ error: "Virheellinen pyyntö" }, { status: 400 });
  await expect(apiPost("/api/accounts", { name: "" }, stub)).rejects.toThrow("Virheellinen pyyntö");
});

test("apiUpload posts a FormData body without a manual content-type header", async () => {
  let seenInit: RequestInit | undefined;
  const stub = async (_path: string | URL | Request, init?: RequestInit) => {
    seenInit = init;
    return Response.json({ imported: 3 }, { status: 200 });
  };
  const form = new FormData();
  form.set("file", new Blob(["a,b"], { type: "text/csv" }), "sample.csv");
  const body = await apiUpload<{ imported: number }>("/api/imports/nordnet", form, stub);
  expect(body).toEqual({ imported: 3 });
  expect(seenInit?.method).toBe("POST");
  expect(seenInit?.credentials).toBe("include");
  expect(seenInit?.body).toBe(form);
  expect(seenInit?.headers).toBeUndefined();
});

test("apiUpload rejects with the server's error on a non-2xx response", async () => {
  const stub = async () => Response.json({ error: "Tiedosto on liian suuri" }, { status: 413 });
  await expect(apiUpload("/api/imports/nordnet", new FormData(), stub)).rejects.toThrow(
    "Tiedosto on liian suuri",
  );
});
