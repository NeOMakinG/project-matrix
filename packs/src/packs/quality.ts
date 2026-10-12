import type { Pack } from "../types";
import { opt } from "./helpers";

export const qualityPack: Pack = {
  id: "quality",
  title: "Quality",
  questions: [
    {
      id: "quality.testStrategy",
      pack: "quality",
      kind: "select",
      field: "quality.testStrategy",
      prompt: "Test strategy?",
      recommended: "tdd",
      rationale: "Tests written first give agents backpressure and resist test gaming.",
      options: [
        opt("tdd", "Test-driven"),
        opt("test-after", "Tests after implementation"),
        opt("e2e-heavy", "E2E-heavy"),
      ],
      adr: {
        topic: "test strategy",
        context: "The checks phase relies on tests as the main backpressure.",
      },
    },
    {
      id: "quality.coverageTarget",
      pack: "quality",
      kind: "number",
      field: "quality.coverageTarget",
      prompt: "Minimum line coverage (%)?",
      recommended: 70,
      rationale: "High enough to catch regressions, low enough not to reward trivial tests.",
    },
    {
      id: "quality.ci",
      pack: "quality",
      kind: "select",
      field: "quality.ci",
      prompt: "CI provider?",
      recommended: "github-actions",
      options: [
        opt("github-actions", "GitHub Actions"),
        opt("gitlab-ci", "GitLab CI"),
        opt("none", "None"),
      ],
      infer: (ctx) =>
        [...ctx.files].some((f) => f.startsWith(".github/workflows/"))
          ? "github-actions"
          : undefined,
    },
  ],
};
