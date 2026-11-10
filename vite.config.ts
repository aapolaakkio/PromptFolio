import { cloudflare } from "@cloudflare/vite-plugin";
import tailwind from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const e2eDir = process.env.E2E_DIR;

/** Runs the server build in workerd, so dev and production share a runtime. Browser tests give each server its own wrangler config and database (e2e/harness/server.ts), and no debugger port to fight over. */
const cloudflareOptions =
  e2eDir === undefined
    ? { viteEnvironment: { name: "ssr" } }
    : {
        viteEnvironment: { name: "ssr" },
        configPath: `${e2eDir}/wrangler.jsonc`,
        persistState: { path: `${e2eDir}/state` },
        inspectorPort: false as const,
      };

export default defineConfig({
  // Better Auth refuses origins other than BASE_URL, pinned to :3000 in wrangler.jsonc.
  server: { port: 3000, strictPort: true },
  plugins: [
    cloudflare(cloudflareOptions),
    tanstackStart({
      srcDirectory: "src/web",
      // Relative to srcDirectory; keeps tests from being read as routes.
      router: { routesDirectory: "app", routeFileIgnorePattern: "\\.test\\." },
    }),
    react(),
    tailwind(),
  ],
});
