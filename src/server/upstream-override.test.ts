import { afterEach, describe, expect, it } from "vitest";

import { installUpstreamOverride } from "./upstream-override.ts";

const guard = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = guard;
});

/** A stand-in for the real fetch that records what it was asked for. */
const recording = () => {
  const seen: Request[] = [];
  globalThis.fetch = (input, init) => {
    seen.push(new Request(input, init));
    return Promise.resolve(new Response("ok"));
  };
  return { seen };
};

describe("installUpstreamOverride", () => {
  it("sends an outbound call to the stand-in with host, path, query, method, headers and body kept", async () => {
    const { seen } = recording();
    installUpstreamOverride("http://127.0.0.1:4899");

    await fetch("https://api.anthropic.com/v1/messages?beta=true", {
      method: "POST",
      headers: { "x-api-key": "k" },
      body: "hello",
    });

    expect(seen).toHaveLength(1);
    const [request] = seen;
    expect(request?.url).toBe("http://127.0.0.1:4899/api.anthropic.com/v1/messages?beta=true");
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("x-api-key")).toBe("k");
    expect(await request?.text()).toBe("hello");
  });

  it("accepts localhost as well", async () => {
    const { seen } = recording();
    installUpstreamOverride("http://localhost:4899");
    await fetch("https://example.com/a");
    expect(seen[0]?.url).toBe("http://localhost:4899/example.com/a");
  });

  it.each([
    undefined,
    "",
    "https://evil.example",
    "http://10.0.0.1:1",
    "https://127.0.0.1:1",
    "nonsense",
    "http://localhost:1@evil.example",
    "http://127.0.0.1:80.evil.example",
    "HTTP://LOCALHOST:1",
    "http://[::1]:1",
    "http://127.0.0.1:1/x",
  ])("leaves fetch alone for %s", (target) => {
    recording();
    const before = globalThis.fetch;
    installUpstreamOverride(target);
    expect(globalThis.fetch).toBe(before);
  });

  it("does not wrap twice when the module is loaded again", async () => {
    const { seen } = recording();
    installUpstreamOverride("http://127.0.0.1:4899");
    installUpstreamOverride("http://127.0.0.1:4899");
    await fetch("https://example.com/a");
    expect(seen[0]?.url).toBe("http://127.0.0.1:4899/example.com/a");
  });
});
