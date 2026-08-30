import tailwind from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // Temporary, for the stages between this one and the API moving into Start:
    // the pages are served by Vite while /api/* is still answered by the old
    // Bun server on 3000. Deleted when the last handler becomes a server
    // function and that server stops existing.
    proxy: { "/api": "http://localhost:3000" },
  },
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
