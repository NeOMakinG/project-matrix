import { describe, expect, it } from "vitest";
import { manualQaPlan, manualQaStillAllowed } from "./manual-qa.js";
import { classifyPath, labelSurfaces, laneSurfaceSet, routeQaSurfaces } from "./qa-surfaces.js";
import type { ProjectConfig, QaSurface } from "./types.js";

const project = (surfaces: QaSurface[], driver?: "manual" | "agent") =>
  ({ id: "p", qa: { surfaces, ...(driver ? { driver } : {}) } }) as unknown as ProjectConfig;

describe("classifyPath", () => {
  it.each([
    ["app/ios/Podfile", "ios"],
    ["app/src/Thumb.ios.tsx", "ios"],
    ["app/ios/App.xcodeproj/project.pbxproj", "ios"],
    ["app/android/app/build.gradle", "android"],
    ["src/Thumb.android.ts", "android"],
    ["src/Thumb.web.tsx", "web"],
    ["apps/web/src/page.tsx", "web"],
    ["server/routes/trips.ts", "backend"],
    ["supabase/migrations/001.sql", "backend"],
    ["docs/qa.md", "backend"],
    ["app/src/api/client.ts", "shared"],
    ["app/src/screens/Trip.tsx", "shared"],
  ])("%s -> %s", (path, kind) => expect(classifyPath(path)).toBe(kind));
});

describe("labelSurfaces", () => {
  it("reads plain and prefixed labels, ignores verdict labels", () => {
    expect(labelSurfaces(["iOS", "platform:android", "qa:passed", "bug", "surface: web"])).toEqual([
      "ios",
      "android",
      "web",
    ]);
  });
});

describe("routeQaSurfaces", () => {
  const mobile = project(["android", "ios"], "agent");

  it("defaults to every configured lane surface", () => {
    expect(routeQaSurfaces(mobile, { body: "" }).surfaces).toEqual(["android", "ios"]);
  });

  it("labels narrow but never add a surface", () => {
    expect(routeQaSurfaces(mobile, { body: "", labels: ["ios"] }).surfaces).toEqual(["ios"]);
    expect(
      routeQaSurfaces(project(["android"], "agent"), { body: "", labels: ["ios"] }).surfaces,
    ).toEqual(["android"]);
  });

  it("a label or body naming only backend never escapes lane QA", () => {
    expect(routeQaSurfaces(mobile, { body: "", labels: ["backend"] }).surfaces).toEqual([
      "android",
      "ios",
    ]);
  });

  it("platform-only paths narrow; shared code keeps both", () => {
    expect(routeQaSurfaces(mobile, { body: "" }, ["app/ios/Podfile"]).surfaces).toEqual(["ios"]);
    expect(
      routeQaSurfaces(mobile, { body: "" }, ["app/ios/Podfile", "app/src/Trip.tsx"]).surfaces,
    ).toEqual(["android", "ios"]);
  });

  it("a declaration never hides a platform the diff touches", () => {
    expect(
      routeQaSurfaces(mobile, { body: "", labels: ["android"] }, [
        "app/ios/Podfile",
        "app/src/a.tsx",
      ]).surfaces,
    ).toEqual(["android", "ios"]);
    const withApi = project(["android", "api"], "agent");
    expect(
      routeQaSurfaces(withApi, { body: "", labels: ["backend"] }, ["app/src/a.tsx"]).surfaces,
    ).toEqual(["android"]);
  });

  it("a backend-only diff routes to the existing checks", () => {
    const r = routeQaSurfaces(mobile, { body: "", labels: ["ios"] }, ["server/x.ts", "a.md"]);
    expect(r).toEqual({ surfaces: [], backendOnly: true, source: "backend-only" });
  });

  it("paths for an unconfigured platform never remove the configured one", () => {
    expect(
      routeQaSurfaces(project(["android"], "agent"), { body: "" }, ["app/ios/Podfile"]).surfaces,
    ).toEqual(["android"]);
  });

  it("web is a lane surface only with the agent driver", () => {
    expect(laneSurfaceSet(project(["web"], "agent")).has("web")).toBe(true);
    expect(laneSurfaceSet(project(["web"], "manual")).has("web")).toBe(false);
    expect(routeQaSurfaces(project(["web", "api"], "manual"), { body: "" }).surfaces).toEqual([]);
  });
});

describe("manualQaPlan routing", () => {
  it("sends web to the agent lane even with an in-run web probe", () => {
    const plan = manualQaPlan(project(["web", "api"], "agent"), { body: "" }, [
      "host",
      "api",
      "web",
    ]);
    expect(plan).toEqual({ mode: "manual", surfaces: ["web"], tester: "agent" });
  });

  it("backend-only change runs the existing checks", () => {
    expect(
      manualQaPlan(project(["android", "ios"], "agent"), { body: "" }, [], ["server/a.ts"]),
    ).toEqual({ mode: "auto" });
  });

  it("an agent web handoff stays allowed", () => {
    expect(
      manualQaStillAllowed(project(["web"], "agent"), {
        surfaces: ["web"],
        criteria: [],
        tester: "agent",
      } as never),
    ).toBe(true);
  });
});
