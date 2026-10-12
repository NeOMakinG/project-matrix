import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e-real",
  workers: 1,
  timeout: 180_000,
  reporter: [["list"]],
  use: {
    baseURL: process.env.MATRIX_E2E_BASE_URL,
    viewport: { width: 1440, height: 900 },
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
});
