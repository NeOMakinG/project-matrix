import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: [
            "apps/*/src/**/*.test.ts",
            "packages/*/src/**/*.test.ts",
            "packs/src/**/*.test.ts",
          ],
          exclude: ["apps/dashboard/**", "**/node_modules/**"],
        },
      },
      "apps/dashboard/vitest.config.ts",
    ],
  },
});
