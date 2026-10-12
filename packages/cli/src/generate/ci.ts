import { spawnSync } from "node:child_process";
import type { MatrixConfig } from "@matrix/config";

/** Repository of the factory tooling used by generated CI. */
export const MATRIX_TOOL_REPO = "NeOMakinG/project-matrix";

const git = (args: string[]) =>
  spawnSync("git", args, { cwd: import.meta.dirname, encoding: "utf8" });

/**
 * Commit of the factory tooling to pin in generated CI. Only commits on the tool's main line are
 * pinned: the newest release tag reachable from `origin/main`, else `origin/main` itself. A
 * feature-branch commit the tool happens to run from is never used.
 */
export function toolCommit(): string | undefined {
  const sha = (ref: string) => {
    const out = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).stdout?.trim();
    return out && /^[0-9a-f]{40}$/.test(out) ? out : undefined;
  };
  const tag = git(["describe", "--tags", "--abbrev=0", "origin/main"]).stdout?.trim();
  return (tag ? sha(tag) : undefined) ?? sha("origin/main");
}

/**
 * GitHub Actions workflow for a generated project: typecheck, lint, tests, then the factory's
 * gates. ADR rules are loaded from the PR's base branch (`--rules-from`), so a PR cannot weaken
 * the rules it is checked against; the tooling is pinned to a commit.
 */
/** `ref: null` means no main-line commit could be found; the workflow then asks to pin one. */
export function ciWorkflow(c: MatrixConfig, ref: string | null = toolCommit() ?? null): string {
  const pinned = ref ?? "main";
  const extraJobs = [goJob(c), tauriJob(c)].filter(Boolean).join("");
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
${extraJobs}`;
}

const goJob = (c: MatrixConfig) =>
  c.backend?.kind !== "go"
    ? ""
    : `
  go:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: services/api
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version-file: services/api/go.mod
      - run: go build -mod=mod ./...
      - run: go vet ./...
      - uses: golangci/golangci-lint-action@v8
        with:
          working-directory: services/api
`;

const tauriJob = (c: MatrixConfig) =>
  c.desktop?.framework !== "tauri"
    ? ""
    : `
  desktop-rust:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
      - uses: dtolnay/rust-toolchain@stable
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run --cwd apps/desktop check:rust
`;
