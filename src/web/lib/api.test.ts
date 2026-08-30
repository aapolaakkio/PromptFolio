import { test, expect } from "vitest";
import { z } from "zod";
import { ApiError, apiDelete, apiGet, apiPatch, apiPost, apiUpload } from "./api.ts";

test("apiGet returns the parsed JSON body on a 2xx response (no schema, cast fallback)", async () => {
  const stub = async () => Response.json({ holdings: [] }, { status: 200 });
  const body = await apiGet<{ holdings: unknown[] }>("/api/holdings", undefined, stub);
  expect(body).toEqual({ holdings: [] });
});

test("apiGet parses the response through a supplied Zod schema", async () => {
  const stub = async () => Response.json({ holdings: ["AAPL"] }, { status: 200 });
  const schema = z.object({ holdings: z.array(z.string()) });
  const body = await apiGet("/api/holdings", schema, stub);
  expect(body).toEqual({ holdings: ["AAPL"] });
});

test("apiGet throws a ZodError when a 2xx body does not match the supplied schema", async () => {
  const stub = async () => Response.json({ wrong: "shape" }, { status: 200 });
  const schema = z.object({ holdings: z.array(z.string()) });
  await expect(apiGet("/api/holdings", schema, stub)).rejects.toThrow(z.ZodError);
});

/** `instanceof` narrows `cause` to ApiError with no assertion needed. */
const expectApiError = (cause: unknown): ApiError => {
  if (!(cause instanceof ApiError)) throw new Error("expected an ApiError");
  return cause;
};

test("apiGet throws ApiError with the server's Finnish message on a non-2xx response", async () => {
  const stub = async () => Response.json({ error: "Kirjautuminen vaaditaan" }, { status: 401 });
  await expect(apiGet("/api/accounts", undefined, stub)).rejects.toThrow(ApiError);
  try {
    await apiGet("/api/accounts", undefined, stub);
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
    await apiGet("/api/holdings", undefined, stub);
    throw new Error("expected apiGet to reject");
  } catch (cause) {
    expect(expectApiError(cause).message).toBe("Virhe 500");
  }
});

test("apiGet falls back to a read-failure message when a non-2xx body is not valid JSON", async () => {
  const stub = async () => new Response("<html>not json</html>", { status: 502 });
  try {
    await apiGet("/api/holdings", undefined, stub);
    throw new Error("expected apiGet to reject");
  } catch (cause) {
    expect(expectApiError(cause).message).toBe("Vastausta ei voitu lukea");
  }
});

test("apiGet returns the read-failure fallback body when a 2xx response is not valid JSON", async () => {
  const stub = async () => new Response("<html>not json</html>", { status: 200 });
  const body = await apiGet<{ error: string }>("/api/holdings", undefined, stub);
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
    undefined,
    stub,
  );
  expect(body).toEqual({ ok: true });
  expect(seenInit?.method).toBe("POST");
  expect(seenInit?.credentials).toBe("include");
  expect(seenInit?.body).toBe(JSON.stringify({ name: "Nordnet" }));
  expect(new Headers(seenInit?.headers).get("content-type")).toBe("application/json");
});

test("apiPost parses the response through a supplied Zod schema", async () => {
  const stub = async () => Response.json({ id: 7 }, { status: 200 });
  const schema = z.object({ id: z.number() });
  const body = await apiPost("/api/accounts", { name: "Nordnet" }, schema, stub);
  expect(body).toEqual({ id: 7 });
});

test("apiPost surfaces a server-side validation error", async () => {
  const stub = async () => Response.json({ error: "Virheellinen pyyntö" }, { status: 400 });
  await expect(apiPost("/api/accounts", { name: "" }, undefined, stub)).rejects.toThrow(
    "Virheellinen pyyntö",
  );
});

test("apiUpload posts a FormData body without a manual content-type header", async () => {
  let seenInit: RequestInit | undefined;
  const stub = async (_path: string | URL | Request, init?: RequestInit) => {
    seenInit = init;
    return Response.json({ imported: 3 }, { status: 200 });
  };
  const form = new FormData();
  form.set("file", new Blob(["a,b"], { type: "text/csv" }), "sample.csv");
  const body = await apiUpload<{ imported: number }>("/api/imports/nordnet", form, undefined, stub);
  expect(body).toEqual({ imported: 3 });
  expect(seenInit?.method).toBe("POST");
  expect(seenInit?.credentials).toBe("include");
  expect(seenInit?.body).toBe(form);
  expect(seenInit?.headers).toBeUndefined();
});

test("apiUpload parses the response through a supplied Zod schema", async () => {
  const stub = async () => Response.json({ imported: 5 }, { status: 200 });
  const schema = z.object({ imported: z.number() });
  const body = await apiUpload("/api/imports/nordnet", new FormData(), schema, stub);
  expect(body).toEqual({ imported: 5 });
});

test("apiUpload rejects with the server's error on a non-2xx response", async () => {
  const stub = async () => Response.json({ error: "Tiedosto on liian suuri" }, { status: 413 });
  await expect(apiUpload("/api/imports/nordnet", new FormData(), undefined, stub)).rejects.toThrow(
    "Tiedosto on liian suuri",
  );
});

test("apiPatch sends a JSON body with credentials and the right method", async () => {
  let seenInit: RequestInit | undefined;
  const stub = async (_path: string | URL | Request, init?: RequestInit) => {
    seenInit = init;
    return Response.json({ id: 1, name: "Nordnet OST" }, { status: 200 });
  };

  const body = await apiPatch<{ id: number; name: string }, { name: string }>(
    "/api/accounts/1",
    { name: "Nordnet OST" },
    undefined,
    stub,
  );
  expect(body.name).toBe("Nordnet OST");
  expect(seenInit?.method).toBe("PATCH");
  expect(seenInit?.credentials).toBe("include");
  expect(seenInit?.body).toBe(JSON.stringify({ name: "Nordnet OST" }));
});

test("apiPatch parses the response through a supplied schema", async () => {
  const schema = z.object({ id: z.number(), name: z.string() });
  const stub = async () => Response.json({ id: 7, name: "OP" }, { status: 200 });
  expect(await apiPatch("/api/accounts/7", { name: "OP" }, schema, stub)).toEqual({
    id: 7,
    name: "OP",
  });
});

test("apiPatch surfaces the server's message on a rejected change", async () => {
  const stub = async () => Response.json({ error: "Nimi ei voi olla tyhjä" }, { status: 400 });
  try {
    await apiPatch("/api/accounts/1", { name: "" }, undefined, stub);
    throw new Error("expected a rejection");
  } catch (cause) {
    expect(expectApiError(cause).message).toBe("Nimi ei voi olla tyhjä");
  }
});

test("apiDelete sends DELETE with credentials and reads no body", async () => {
  let seenInit: RequestInit | undefined;
  const stub = async (_path: string | URL | Request, init?: RequestInit) => {
    seenInit = init;
    return Response.json({ deleted: 3 }, { status: 200 });
  };

  await apiDelete("/api/snapshots/3", stub);
  expect(seenInit?.method).toBe("DELETE");
  expect(seenInit?.credentials).toBe("include");
  expect(seenInit?.body).toBeUndefined();
});

test("apiDelete surfaces the server's message when the delete is refused", async () => {
  const stub = async () => Response.json({ error: "Tilannevedosta ei löydy" }, { status: 404 });
  try {
    await apiDelete("/api/snapshots/999", stub);
    throw new Error("expected a rejection");
  } catch (cause) {
    expect(expectApiError(cause).message).toBe("Tilannevedosta ei löydy");
  }
});
