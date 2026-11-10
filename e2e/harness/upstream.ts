import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type UpstreamCall = { readonly host: string; readonly path: string; readonly body: string };

type Handler = (call: UpstreamCall) => Response | undefined;

/** Stands in for every service the Worker calls (Claude, Yahoo, ECB): the Worker sends `<url>/<host><path>` here instead. */
export type Upstream = {
  readonly url: string;
  readonly calls: readonly UpstreamCall[];
  /** Calls no handler answered; a test that leaves one here reached for the network unscripted. */
  readonly unexpected: readonly string[];
  on(host: string, handler: Handler): void;
  /** For a stand-in that answers a call it considers a test mistake: the answer goes out, and the test still fails. */
  flag(description: string): void;
  reset(): void;
  stop(): Promise<void>;
};

export const startUpstream = async (): Promise<Upstream> => {
  // Mutated in place: one long-lived server collects what many requests bring.
  const calls: UpstreamCall[] = [];
  const unexpected: string[] = [];
  const handlers = new Map<string, Handler>();

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const [, host = "", ...rest] = (req.url ?? "/").split("/");
      const call = { host, path: `/${rest.join("/")}`, body: Buffer.concat(chunks).toString() };
      calls.push(call);
      const response = handlers.get(host)?.(call);
      if (response === undefined) {
        unexpected.push(`${req.method} ${host}${call.path}`);
        res.writeHead(502).end("e2e: no stand-in answer for this call");
        return;
      }
      void response.arrayBuffer().then((body) => {
        res.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(body));
      });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  // SAFETY: a listening TCP server's address is an AddressInfo.
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    unexpected,
    on: (host, handler) => void handlers.set(host, handler),
    flag: (description) => void unexpected.push(description),
    reset: () => {
      calls.length = 0;
      unexpected.length = 0;
      handlers.clear();
    },
    stop: () => new Promise((done) => server.close(() => done())),
  };
};
