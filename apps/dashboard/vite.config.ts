import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiProxy = process.env.MATRIX_API_PROXY;

/**
 * Build output is a static bundle meant to be hosted by matrix-server on the
 * same origin: `dist/index.html` + hashed `dist/assets/*`. VITE_BASE sets the
 * mount path (default "/"); the router reads it as its basepath. API calls go
 * to `/v1` and `/auth` on the same origin, so no CORS is needed.
 */
export default defineConfig(({ command }) => ({
  base: process.env.VITE_BASE ?? "/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // The MSW worker is only served by the dev server; builds never copy it.
  publicDir: command === "serve" ? "mocks-public" : false,
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@xyflow")) return "graph";
          if (id.includes("@tanstack")) return "tanstack";
          if (id.includes("@radix-ui") || id.includes("cmdk")) return "radix";
          if (id.includes("react-dom") || id.includes("/react/") || id.includes("scheduler"))
            return "react";
          return undefined;
        },
      },
    },
  },
  server: {
    port: Number(process.env.DASHBOARD_PORT ?? 5178),
    strictPort: true,
    // Dev only: proxy the API to a local matrix-server so the browser sees one origin.
    ...(apiProxy
      ? {
          proxy: {
            "/v1": { target: apiProxy, changeOrigin: false },
            "/auth": { target: apiProxy, changeOrigin: false },
          },
        }
      : {}),
  },
  preview: { port: 5178, strictPort: true },
}));
