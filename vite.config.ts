import tailwind from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tanstackStart({
      srcDirectory: "src/web",
      // Relative to srcDirectory, not to the project root.
      router: { routesDirectory: "app" },
    }),
    react(),
    tailwind(),
  ],
});
