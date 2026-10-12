import type { MatrixConfig } from "@matrix/config";

/** Repository and ref of the factory tooling used by generated CI. */
export const MATRIX_TOOL_REPO = "NeOMakinG/project-matrix";
export const MATRIX_TOOL_REF = "main";

/**
 * GitHub Actions workflow for a generated project: typecheck, lint, tests, then the factory's
 * own gates — `matrix check` (ADR rules) and `matrix graph --check` (code graph drift).
 */
export function ciWorkflow(_c: MatrixConfig): string {
  return `name: ci

on:
  pull_request:
  push:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run typecheck
      - run: bun run lint
      - run: bun run test

  matrix:
    runs-on: ubuntu-latest
    env:
      MATRIX_REF: \${{ vars.MATRIX_REF || '${MATRIX_TOOL_REF}' }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/checkout@v4
        with:
          repository: ${MATRIX_TOOL_REPO}
          ref: \${{ env.MATRIX_REF }}
          path: .matrix-tool
      - uses: oven-sh/setup-bun@v2
      - run: bun install --cwd .matrix-tool
      - name: ADR rules
        run: bun .matrix-tool/packages/cli/src/bin.ts check .
      - name: Code graph is up to date
        run: bun .matrix-tool/packages/cli/src/bin.ts graph . --check
`;
}
