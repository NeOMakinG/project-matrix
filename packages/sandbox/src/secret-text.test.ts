import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { scanSecretText } from "./secret-gate.js";

test("text scanner fails closed when unavailable", async () => {
  expect(await scanSecretText("innocent output", "/nonexistent/matrix-gitleaks")).toBe(false);
});

const installed = spawnSync("gitleaks", ["version"]).status === 0;
test.skipIf(!installed)(
  "real gitleaks stdin scans committed-secret output with no repository allowlists",
  async () => {
    expect(await scanSecretText("observed sum: 5")).toBe(true);
    const planted = ["gh", "p_", "x7Y2kL9pQ4aB6cD8eF1gH3iJ5mN0oP2rS4tU"].join("");
    expect(await scanSecretText(`token=${planted} # gitleaks:allow`)).toBe(false);
  },
);
