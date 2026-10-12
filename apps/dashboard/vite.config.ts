import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
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
  server: { port: 5178, strictPort: true },
  preview: { port: 5178, strictPort: true },
}));
