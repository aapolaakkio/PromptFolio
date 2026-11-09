import { cloudflare } from "@cloudflare/vite-plugin";
import tailwind from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Better Auth refuses origins other than BASE_URL, pinned to :3000 in wrangler.jsonc.
  server: { port: 3000, strictPort: true },
  plugins: [
    // Runs the server build in workerd, so dev and production share a runtime.
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart({
      srcDirectory: "src/web",
      // Relative to srcDirectory; keeps tests from being read as routes.
      router: { routesDirectory: "app", routeFileIgnorePattern: "\\.test\\." },
    }),
    react(),
    tailwind(),
  ],
});
