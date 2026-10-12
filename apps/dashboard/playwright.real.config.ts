import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/** E2E against a real matrix-server on 127.0.0.1; both servers are started and killed by Playwright. */
const SERVER_PORT = 8741;
const DASHBOARD_PORT = 5181;
const token =
  process.env.MATRIX_E2E_TOKEN ??
  `mx_${randomBytes(6).toString("hex")}_${randomBytes(32).toString("base64url")}`;
process.env.MATRIX_E2E_TOKEN = token;
const scratch = mkdtempSync(join(tmpdir(), "matrix-e2e-"));

export default defineConfig({
  testDir: "./e2e-real",
  workers: 1,
  timeout: 120_000,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${DASHBOARD_PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: [
    {
      command: "bun ../server/src/main.ts",
      url: `http://127.0.0.1:${SERVER_PORT}/auth/session`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        MATRIX_HOST: "127.0.0.1",
        MATRIX_PORT: String(SERVER_PORT),
        MATRIX_BOOTSTRAP_TOKEN: token,
        MATRIX_INSECURE_COOKIES: "1",
        MATRIX_DASHBOARD_ORIGINS: `http://127.0.0.1:${DASHBOARD_PORT}`,
        MATRIX_REPLAY_LOG: join(scratch, "replay.log"),
        MATRIX_AUDIT_FILE: join(scratch, "audit.log"),
      },
    },
    {
      command: `bun run vite --host 127.0.0.1 --port ${DASHBOARD_PORT}`,
      url: `http://127.0.0.1:${DASHBOARD_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        DASHBOARD_PORT: String(DASHBOARD_PORT),
        MATRIX_API_PROXY: `http://127.0.0.1:${SERVER_PORT}`,
      },
    },
  ],
});
