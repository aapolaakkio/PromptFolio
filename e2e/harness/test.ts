import { randomUUID } from "node:crypto";

import { expect, test as base } from "@playwright/test";

import { startServer, type AppServer } from "./server.ts";
import { startUpstream, type Upstream } from "./upstream.ts";

export type App = { readonly baseURL: string; readonly upstream: Upstream };
export type TestUser = { readonly name: string; readonly email: string; readonly password: string };

type TestFixtures = {
  /** A new signed-in user of this test alone: tests sharing a worker's database never see each other's rows. */
  user: TestUser;
  /** A server and empty database of this test alone, with no user yet: for the first-run form. */
  freshApp: App;
  upstreamGuard: void;
};
type WorkerFixtures = { app: App };

const start = async (): Promise<{ app: App; server: AppServer }> => {
  const upstream = await startUpstream();
  const server = await startServer(upstream.url);
  return { app: { baseURL: server.baseURL, upstream }, server };
};

const stop = async (app: App, server: AppServer): Promise<void> => {
  await server.stop();
  await app.upstream.stop();
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  app: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright reads the fixture's dependencies from this pattern.
    async ({}, use) => {
      const { app, server } = await start();
      await use(app);
      await stop(app, server);
    },
    { scope: "worker", timeout: 120_000 },
  ],

  // The dev server sends server-rendered HTML first; a click before React has attached does a plain form post and loses the action.
  page: async ({ page }, use) => {
    const goto = page.goto.bind(page);
    page.goto = async (url, options) => {
      const response = await goto(url, options);
      await page.waitForLoadState("networkidle");
      return response;
    };
    await use(page);
  },

  baseURL: async ({ app }, use) => {
    await use(app.baseURL);
  },

  user: async ({ page, app }, use) => {
    const user = {
      name: "E2E Tester",
      email: `e2e-${randomUUID()}@example.com`,
      password: "correct horse battery staple",
    };
    const response = await page.request.post("/api/auth/sign-up/email", {
      // Better Auth refuses a request whose origin is not BASE_URL.
      headers: { origin: app.baseURL },
      data: user,
    });
    expect(response.ok(), await response.text()).toBe(true);
    await use(user);
  },

  freshApp: [
    // oxlint-disable-next-line no-empty-pattern -- as above.
    async ({}, use) => {
      const { app, server } = await start();
      await use(app);
      await stop(app, server);
    },
    { timeout: 120_000 },
  ],

  upstreamGuard: [
    async ({ app }, use) => {
      app.upstream.reset();
      await use();
      expect(app.upstream.unexpected, "outbound calls the test did not script").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
