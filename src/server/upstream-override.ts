const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/;

const MARK = Symbol.for("promptfolio.upstream-override");

/**
 * Browser tests only: sends every outbound call of the Worker (Claude, Yahoo, ECB) to a stand-in on this machine, as `<target>/<host><path>`.
 * Anything but a loopback address is ignored, so a wrong setting in production cannot send the ledger or the API key elsewhere.
 */
export const installUpstreamOverride = (target: string | undefined): void => {
  if (target === undefined || !LOOPBACK.test(target)) return;
  // Vite reloads the entry module; a second wrap would prefix the address twice.
  if (MARK in globalThis.fetch) return;
  const real = globalThis.fetch;
  const rerouted: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    return real(new Request(`${target}/${url.host}${url.pathname}${url.search}`, request));
  };
  globalThis.fetch = Object.assign(rerouted, { [MARK]: true });
};
