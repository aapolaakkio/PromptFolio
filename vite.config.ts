import { cloudflare } from "@cloudflare/vite-plugin";
import tailwind from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Better Auth refuses any origin other than BASE_URL, which wrangler.jsonc
  // pins to :3000 for local runs; `pnpm preview` passes the same port to
  // wrangler dev.
  server: { port: 3000, strictPort: true },
  plugins: [
    // Runs the server build inside workerd, both in `vite dev` and in the
    // bundle `wrangler deploy` uploads, so local and production are the same
    // runtime. Bindings come from wrangler.jsonc.
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart({
      srcDirectory: "src/web",
      // Relative to srcDirectory, not to the project root.
      router: { routesDirectory: "app" },
    }),
    react(),
    tailwind(),
  ],
});
