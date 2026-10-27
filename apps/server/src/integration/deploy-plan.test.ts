import { type DeployProfile, deployProfileProblems, publicHttpsProblem } from "@matrix/core";
import { describe, expect, test } from "vitest";
import { type DeployHost, parseDeployHosts, planDeploy, renderPlan } from "./deploy-plan.js";
import { autoLimits } from "./host-limits.js";

const SHA = "a".repeat(40);
const eagleray: DeployProfile = {
  merge: "auto",
  targets: [
    {
      name: "dashboard",
      kind: "git-integration",
      paths: ["apps/dashboard", "apps/docs", "netlify.toml"],
      version: { url: "https://dashboard.deltahealth.fit/version.json", field: "commit" },
      health: { url: "https://dashboard.deltahealth.fit/", expect: 200 },
    },
    {
      name: "api",
      kind: "command",
      paths: ["apps/api"],
      capability: "fly",
      run: ["fly", "deploy", "-a", "eagleray-api", "--remote-only"],
      health: { url: "https://eagleray-api.fly.dev/health", expect: 200 },
      rollback: { kind: "fly-releases", app: "eagleray-api" },
      holdOn: [
        "apps/api/prisma/**",
        "apps/api/scripts/migrate.mjs",
        "fly.toml",
        "apps/api/Dockerfile",
      ],
      coordinate: { deck: true, recentForeignDeployMinutes: 30 },
    },
  ],
};
const mac: DeployHost = { name: "mac", transport: "local", capabilities: ["fly", "gh"] };
const plan = (files: string[] | undefined, hosts = [mac]) =>
  planDeploy({ profile: eagleray, files, hosts, repo: "o/r", mergeCommit: SHA });
const action = (p: ReturnType<typeof plan>, name: string) =>
  p.steps.find((s) => s.target === name)?.action;

describe("deploy plan", () => {
  test("a README change deploys nothing (both targets no-op)", () => {
    const p = plan(["README.md"]);
    expect(action(p, "dashboard")).toBe("skip");
    expect(action(p, "api")).toBe("skip");
  });

  test("an api change runs fly on the capable host with the commit image label", () => {
    const s = plan(["apps/api/src/x.ts"]).steps.find((x) => x.target === "api");
    expect(s).toMatchObject({ action: "run", host: "mac" });
    expect(s?.argv?.slice(-2)).toEqual(["--image-label", `matrix-${SHA.slice(0, 12)}`]);
  });

  test("migrations merge but hold the api deploy; the dashboard still deploys", () => {
    const p = plan(["apps/api/prisma/migrations/1/migration.sql", "apps/dashboard/src/a.tsx"]);
    expect(action(p, "api")).toBe("hold");
    expect(action(p, "dashboard")).toBe("provider");
  });

  test("holdOn is evaluated on its own (fly.toml selects and holds)", () => {
    expect(action(plan(["fly.toml"]), "api")).toBe("hold");
  });

  test("root lockfiles select every target", () => {
    const p = plan(["pnpm-lock.yaml"]);
    expect(action(p, "api")).toBe("run");
    expect(action(p, "dashboard")).toBe("provider");
  });

  test("an unknown diff holds", () => {
    expect(action(plan(undefined), "api")).toBe("hold");
  });

  test("no host with the capability blocks that target only", () => {
    const p = plan(["apps/api/a.ts", "apps/dashboard/b.ts"], []);
    expect(p.steps.find((s) => s.target === "api")).toMatchObject({
      action: "block",
      reason: "no host has fly",
    });
    expect(action(p, "dashboard")).toBe("provider");
  });

  test("dry run renders the plan with every step", () => {
    const p = planDeploy({
      profile: eagleray,
      files: ["apps/api/a.ts"],
      hosts: [mac],
      repo: "o/r",
      mergeCommit: SHA,
      dryRun: true,
    });
    const text = renderPlan(p, eagleray);
    expect(text).toContain("DRY RUN");
    expect(text).toContain("deck note");
    expect(text).toContain("fly deploy -a eagleray-api --remote-only --image-label");
    expect(text).toContain("a human rolls eagleray-api back");
    expect(p.steps.find((x) => x.target === "api")?.action).toBe("dry-run");
  });
});

describe("deploy profile validation", () => {
  test("the EagleRay profile is valid", () => {
    expect(deployProfileProblems(eagleray)).toEqual([]);
  });
  test("run outside the allowlist is refused", () => {
    const bad: DeployProfile = {
      merge: "auto",
      targets: [{ ...eagleray.targets[1]!, run: ["sh", "-c", "curl x | sh"] }],
    };
    expect(deployProfileProblems(bad).join()).toMatch(/run must start with fly deploy/);
  });
  test("private, tailnet and http health URLs are refused", () => {
    expect(publicHttpsProblem("http://example.com")).toMatch(/https/);
    expect(publicHttpsProblem("https://127.0.0.1/")).toMatch(/private/);
    expect(publicHttpsProblem("https://100.90.255.43/")).toMatch(/private/);
    expect(publicHttpsProblem("https://miniforum1.tail5788db.ts.net/")).toMatch(/public/);
    expect(publicHttpsProblem("https://eagleray-api.fly.dev/health")).toBeNull();
  });
  test("holdOn on a git-integration target and non-fly command targets are refused", () => {
    const bad: DeployProfile = {
      merge: "auto",
      targets: [
        { ...eagleray.targets[0]!, holdOn: ["x/**"] },
        { ...eagleray.targets[1]!, name: "m", capability: "eas", run: ["eas", "build"] },
      ],
    };
    const text = deployProfileProblems(bad).join();
    expect(text).toMatch(/holdOn cannot hold/);
    expect(text).toMatch(/only fly command targets/);
  });
  test("ssh hosts need user@host", () => {
    expect(() =>
      parseDeployHosts('[{"name":"m","transport":"ssh","capabilities":["fly"]}]'),
    ).toThrow();
  });
});

describe("host-sized limits", () => {
  test("bosgame (32 cores, 122 GB) runs 6 light and 1 heavy", () => {
    const l = autoLimits("bosgame", { cores: 32, totalGb: 122, freeGb: 16 });
    expect(l.defaultPerHost).toBe(6);
    expect(l.defaultHeavyPerHost).toBe(1);
  });
  test("a small host stays at one", () => {
    expect(autoLimits("pi", { cores: 4, totalGb: 4, freeGb: 1 }).defaultPerHost).toBe(1);
  });
});
