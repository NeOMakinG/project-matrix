import { expect, test } from "vitest";
import type { PullRequestFacts } from "./qa-criteria.js";
import { laneRunSurfaces } from "./reconcile.js";
import type { ProjectConfig } from "./types.js";

const project = {
  id: "tj",
  qa: { surfaces: ["android", "ios"], driver: "agent" },
} as ProjectConfig;
const facts = (paths: string[]) =>
  ({
    headSha: "a",
    body: "",
    files: paths.map((path) => ({ path, status: "modified", additions: 1 })),
    checks: [],
    baseFailing: [],
  }) as PullRequestFacts;

test("a rerun adds a surface enabled since the first run when the diff needs it", () => {
  expect(
    laneRunSurfaces(project, { body: "b" }, ["android"], facts(["app/src/Day.tsx"])).sort(),
  ).toEqual(["android", "ios"]);
});

test("an Android-only diff does not add iOS; the snapshot is never narrowed", () => {
  expect(
    laneRunSurfaces(project, { body: "b" }, ["android"], facts(["app/android/x.gradle"])),
  ).toEqual(["android"]);
  expect(laneRunSurfaces(project, { body: "b" }, ["android", "ios"], undefined).sort()).toEqual([
    "android",
    "ios",
  ]);
});
