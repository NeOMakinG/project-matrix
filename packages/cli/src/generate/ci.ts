import { spawnSync } from "node:child_process";
import type { MatrixConfig } from "@matrix/config";

/** Repository of the factory tooling used by generated CI. */
export const MATRIX_TOOL_REPO = "NeOMakinG/project-matrix";

const git = (args: string[]) =>
  spawnSync("git", args, { cwd: import.meta.dirname, encoding: "utf8" });

/**
 * Commit of the factory tooling to pin in generated CI: the running tool's commit when it is
 * published on a remote branch, else the remote main it was built from. Never a moving branch.
 */
export function toolCommit(): string | undefined {
  const head = git(["rev-parse", "HEAD"]).stdout?.trim();
  if (head && git(["branch", "-r", "--contains", head]).stdout?.trim()) return head;
  const main = git(["rev-parse", "origin/main"]).stdout?.trim();
  return main && /^[0-9a-f]{40}$/.test(main) ? main : undefined;
}

/**
 * GitHub Actions workflow for a generated project: typecheck, lint, tests, then the factory's
 * gates. ADR rules are loaded from the PR's base branch (`--rules-from`), so a PR cannot weaken
 * the rules it is checked against; the tooling is pinned to a commit.
 */
export function ciWorkflow(_c: MatrixConfig, ref = toolCommit()): string {
  const pinned = ref ?? "main";
  return `name: ci

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun run lint
      - run: bun run test

  matrix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/checkout@v4
        with:
          repository: ${MATRIX_TOOL_REPO}
          # Pinned factory tooling${ref ? "" : " (no published commit found at init: pin a commit SHA here)"}.
          ref: ${pinned}
          path: .matrix-tool
          persist-credentials: false
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile --cwd .matrix-tool
      - name: ADR rules (loaded from the base branch on pull requests)
        env:
          BASE_REF: \${{ github.base_ref }}
        run: |
          if [ -n "$BASE_REF" ]; then
            bun .matrix-tool/packages/cli/src/bin.ts check . --rules-from "origin/$BASE_REF"
          else
            bun .matrix-tool/packages/cli/src/bin.ts check .
          fi
      - name: Code graph is up to date
        run: bun .matrix-tool/packages/cli/src/bin.ts graph . --check
`;
}
