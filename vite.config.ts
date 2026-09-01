import { cloudflare } from "@cloudflare/vite-plugin";
import tailwind from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
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
