import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { resolve } from "node:path";

import { seedSql } from "./seed.ts";

const ROOT = resolve(import.meta.dirname, "../..");
/** Inside Playwright's output folder: ignored by git, emptied at the start of each run, and nowhere near `.wrangler/` (the real database). */
const STATE = resolve(ROOT, "test-results/e2e");
const START_LIMIT_MS = 60_000;
const KILL_AFTER_MS = 5_000;
/** The owner's `.env` holds a real API key and telemetry posts to Cloudflare: neither is wanted in a test. */
const QUIET_ENV = { WRANGLER_SEND_METRICS: "false" } as const;

const freePort = (): Promise<number> =>
  new Promise((done) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      // SAFETY: a listening TCP server's address is an AddressInfo.
      const { port } = probe.address() as AddressInfo;
      probe.close(() => done(port));
    });
  });

/** Its own wrangler config, so neither the repo's `vars` nor the owner's `.env` (looked up beside the config) reach the test server. */
const wranglerConfig = (baseURL: string, upstreamUrl: string): string =>
  JSON.stringify({
    name: "promptfolio-e2e",
    compatibility_date: "2026-09-01",
    compatibility_flags: ["nodejs_compat"],
    main: resolve(ROOT, "src/worker.ts"),
    d1_databases: [
      {
        binding: "DB",
        database_name: "promptfolio",
        database_id: "e2e",
        migrations_dir: resolve(ROOT, "drizzle"),
        migrations_pattern: resolve(ROOT, "drizzle/*/migration.sql"),
      },
    ],
    vars: {
      BASE_URL: baseURL,
      ALLOW_SIGNUP: "true",
      BETTER_AUTH_SECRET: "e2e-secret-that-is-long-enough-to-be-accepted",
      ANTHROPIC_API_KEY: "e2e-key",
      CRON_SECRET: "e2e-cron",
      E2E_UPSTREAM: upstreamUrl,
    },
  });

/** Run from the state dir: wrangler looks for `.env` in its working directory, and the config's paths are absolute. */
const wrangler = (dir: string, args: readonly string[]): void => {
  execFileSync(
    resolve(ROOT, "node_modules/.bin/wrangler"),
    ["d1", ...args, "--local", "-c", `${dir}/wrangler.jsonc`, "--persist-to", `${dir}/state`],
    { cwd: dir, env: { ...process.env, ...QUIET_ENV }, stdio: "pipe" },
  );
};

const isUp = async (url: string): Promise<boolean> => {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
};

export type AppServer = { readonly baseURL: string; stop(): Promise<void> };

/** A fresh database (migrated and seeded) and a dev server of its own on a free port. */
export const startServer = async (upstreamUrl: string): Promise<AppServer> => {
  const port = await freePort();
  const baseURL = `http://localhost:${port}`;
  const dir = resolve(STATE, String(port));
  // A restarted worker can be handed a port an earlier server used; its old database must not come back.
  if (!dir.startsWith(`${STATE}/`)) throw new Error(`refusing to clear ${dir}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/wrangler.jsonc`, wranglerConfig(baseURL, upstreamUrl));
  writeFileSync(`${dir}/seed.sql`, seedSql());
  wrangler(dir, ["migrations", "apply", "promptfolio"]);
  wrangler(dir, ["execute", "promptfolio", "--file", `${dir}/seed.sql`]);

  const log = `${dir}/server.log`;
  writeFileSync(log, "");
  // Its own process group, so stopping it also stops the workerd it starts.
  const child = spawn(
    resolve(ROOT, "node_modules/.bin/vite"),
    ["dev", "--port", String(port), "--strictPort"],
    {
      cwd: ROOT,
      env: { ...process.env, ...QUIET_ENV, E2E_DIR: dir },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const append = (chunk: Buffer): void => writeFileSync(log, chunk, { flag: "a" });
  child.stdout.on("data", append);
  child.stderr.on("data", append);

  const stop = (): Promise<void> =>
    new Promise((done) => {
      if (child.exitCode !== null || child.pid === undefined) return done();
      const pid = child.pid;
      const killer = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // The group is already gone.
        }
        done();
      }, KILL_AFTER_MS);
      child.once("exit", () => {
        clearTimeout(killer);
        done();
      });
      process.kill(-pid, "SIGTERM");
    });

  const deadline = Date.now() + START_LIMIT_MS;
  while (!(await isUp(`${baseURL}/login`))) {
    if (Date.now() > deadline || child.exitCode !== null) {
      await stop();
      throw new Error(
        `e2e server did not start on ${baseURL}:\n${readFileSync(log, "utf8").slice(-2000)}`,
      );
    }
    await new Promise((tick) => setTimeout(tick, 250));
  }
  return { baseURL, stop };
};
