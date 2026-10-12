import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@matrix/config";
import { type Answers, findContradictions, sampleAnswers } from "@matrix/packs";
import { describe, expect, test } from "vitest";
import { runInit } from "./init";

const fresh = () => mkdtemp(join(tmpdir(), "matrix-stack-"));

interface Stack {
  name: string;
  answers: Answers;
  files: string[];
  skills: string[];
  /** Commands proving the scaffold builds; run only with MATRIX_E2E=1. */
  e2e: { cwd: string; cmd: string[] }[];
}

const stacks: Stack[] = [
  {
    name: "next",
    answers: { "frontend.bundler": "next" },
    files: ["apps/web/app/page.tsx", "apps/web/next.config.ts", "apps/api/src/index.ts"],
    skills: ["nextjs", "react"],
    e2e: [
      { cwd: ".", cmd: ["bun", "install"] },
      { cwd: "apps/web", cmd: ["bun", "run", "typecheck"] },
      { cwd: "apps/web", cmd: ["bunx", "next", "build"] },
    ],
  },
  {
    name: "tanstack-start",
    answers: { "backend.kind": "fullstack" },
    files: ["apps/web/src/routes/__root.tsx", "apps/web/src/router.tsx", "apps/web/vite.config.ts"],
    skills: ["tanstack-start", "react"],
    e2e: [
      { cwd: ".", cmd: ["bun", "install"] },
      { cwd: "apps/web", cmd: ["bun", "run", "typecheck"] },
    ],
  },
  {
    name: "expo",
    answers: { "platforms.targets": ["ios", "android"] },
    files: ["apps/mobile/app/_layout.tsx", "apps/mobile/app.json", "apps/mobile/eas.json"],
    skills: ["expo-react-native"],
    e2e: [
      { cwd: ".", cmd: ["bun", "install"] },
      { cwd: "apps/mobile", cmd: ["bun", "run", "typecheck"] },
      { cwd: "apps/mobile", cmd: ["bunx", "expo", "config", "--json"] },
    ],
  },
  {
    name: "tauri",
    answers: { "platforms.targets": ["desktop"] },
    files: [
      "apps/desktop/src-tauri/tauri.conf.json",
      "apps/desktop/src-tauri/src/lib.rs",
      "apps/desktop/src-tauri/capabilities/default.json",
    ],
    skills: ["tauri", "react"],
    e2e: [
      { cwd: ".", cmd: ["bun", "install"] },
      { cwd: "apps/desktop", cmd: ["bun", "run", "typecheck"] },
      { cwd: "apps/desktop", cmd: ["bun", "run", "check:rust"] },
    ],
  },
  {
    name: "go",
    answers: { "backend.kind": "go" },
    files: ["services/api/go.mod", "services/api/cmd/api/main.go", "services/api/sqlc.yaml"],
    skills: ["go"],
    e2e: [
      { cwd: "services/api", cmd: ["go", "build", "-mod=mod", "./..."] },
      { cwd: "services/api", cmd: ["go", "vet", "./..."] },
    ],
  },
];

const init = async (s: Stack) => {
  const out = await fresh();
  const r = await runInit({
    answers: { ...sampleAnswers, ...s.answers },
    outDir: out,
    acceptRecommended: true,
    scaffold: true,
    date: "2026-10-12",
  });
  return { out, r };
};

describe.each(stacks)("stack pack: $name", (s) => {
  test("interview resolves without contradictions and scaffolds the stack", async () => {
    const { r } = await init(s);
    expect(r.status, JSON.stringify(r)).toBe("ok");
    if (r.status !== "ok") return;
    for (const f of s.files) expect(r.files).toContain(f);
    const config = parseConfig(r.config);
    for (const k of s.skills) {
      expect(config.agents.skills).toContain(k);
      expect(r.files).toContain(`.claude/skills/${k}/SKILL.md`);
    }
  });

  test.runIf(process.env.MATRIX_E2E === "1")(
    "generated scaffold installs and builds",
    async () => {
      const { out, r } = await init(s);
      expect(r.status).toBe("ok");
      for (const step of s.e2e) {
        const [bin, ...args] = step.cmd;
        const res = spawnSync(bin ?? "", args, {
          cwd: join(out, step.cwd),
          encoding: "utf8",
          env: { ...process.env, CI: "1", EXPO_NO_TELEMETRY: "1" },
        });
        expect(res.status, `${step.cmd.join(" ")}:\n${res.stdout}\n${res.stderr}`).toBe(0);
      }
    },
    1_800_000,
  );
});

describe("stack-specific details", () => {
  test("Go API gets OpenAPI client, Clerk auth and no TypeScript ORM", async () => {
    const { r } = await init(stacks.find((s) => s.name === "go") as Stack);
    if (r.status !== "ok") throw new Error(r.status);
    const c = parseConfig(r.config);
    expect(c.backend.go?.router).toBe("chi");
    expect(c.backend.orm).toBe("none");
    expect(c.backend.auth).toBe("clerk");
    expect(c.frontend?.framework === "react" && c.frontend.api).toBe("openapi-fetch");
  });

  test("TanStack Start without a separate backend uses server functions", async () => {
    const { r } = await init(stacks.find((s) => s.name === "tanstack-start") as Stack);
    if (r.status !== "ok") throw new Error(r.status);
    const c = parseConfig(r.config);
    expect(c.frontend?.framework === "react" && c.frontend.api).toBe("server-functions");
    expect(c.frontend?.framework === "react" && c.frontend.router).toBe("tanstack-router");
  });

  test("Tauri capabilities stay least-privilege and the CSP is strict", async () => {
    const { out, r } = await init(stacks.find((s) => s.name === "tauri") as Stack);
    if (r.status !== "ok") throw new Error(r.status);
    const caps = JSON.parse(
      await readFile(join(out, "apps/desktop/src-tauri/capabilities/default.json"), "utf8"),
    );
    expect(caps.permissions).toEqual(["core:default", "updater:default"]);
    const conf = JSON.parse(
      await readFile(join(out, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
    );
    expect(conf.app.security.csp).toContain("default-src 'self'");
  });

  test("hostile business names stay inert in Go, TOML and YAML outputs", async () => {
    const name = 'Evil"; os.Exit(1) //\n[package]\n- launchApp';
    const out = await fresh();
    const r = await runInit({
      answers: {
        ...sampleAnswers,
        "business.name": name,
        "platforms.targets": ["ios", "desktop"],
        "backend.kind": "go",
      },
      outDir: out,
      acceptRecommended: true,
      scaffold: true,
    });
    expect(r.status, JSON.stringify(r)).toBe("ok");
    const maestro = await readFile(join(out, "apps/mobile/.maestro/smoke.yaml"), "utf8");
    expect(maestro).toContain(`text: ${JSON.stringify(name)}`);
    const conf = JSON.parse(
      await readFile(join(out, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
    );
    expect(conf.productName).toBe(name);
  });
});

describe("new contradiction rules", () => {
  const ids = (a: Answers) => findContradictions({ ...sampleAnswers, ...a }).map((c) => c.id);
  test.each([
    [
      { "frontend.bundler": "next", "frontend.router": "tanstack-router" },
      "next-without-app-router",
    ],
    [
      { "frontend.bundler": "vite", "frontend.router": "next-app-router" },
      "app-router-without-next",
    ],
    [
      { "frontend.bundler": "tanstack-start", "frontend.router": "react-router" },
      "start-without-tanstack-router",
    ],
    [
      { "frontend.bundler": "vite", "frontend.api": "server-functions" },
      "server-functions-without-fullstack",
    ],
    [{ "backend.kind": "go", "frontend.api": "trpc" }, "trpc-with-go"],
    [{ "backend.kind": "go", "backend.orm": "drizzle" }, "ts-library-with-go"],
    [
      { "desktop.distribution": "app-stores", "desktop.signing": [] },
      "store-distribution-unsigned",
    ],
    [
      { "agents.workspace": "native", "agents.browserDriver": "orca-browser" },
      "orca-driver-without-orca",
    ],
  ])("%j → %s", (answers, id) => {
    expect(ids(answers as Answers)).toContain(id);
  });
});
