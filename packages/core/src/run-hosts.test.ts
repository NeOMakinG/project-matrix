import { describe, expect, test } from "vitest";
import { pickRunHost } from "./reconcile.js";
import type { Limits, ProjectConfig } from "./types.js";

const limits: Limits = {
  perProject: 4,
  perModel: {},
  defaultPerModel: 9,
  perHost: { bosgame: 2 },
  defaultPerHost: 2,
};
const project = { id: "p", host: "bosgame" } as ProjectConfig;
const hosts = [
  { name: "miniforum", phases: ["implement", "checks"] as const, slots: 2 },
  {
    name: "mac",
    phases: ["checks"] as const,
    slots: 3,
    serves: (p: ProjectConfig) => p.id === "p",
  },
];
const on = (...h: string[]) => h.map((host) => ({ host }));

describe("pickRunHost", () => {
  test("project host wins ties; the freest eligible host otherwise", () => {
    expect(pickRunHost(project, "implement", [], limits, hosts)).toBe("bosgame");
    expect(pickRunHost(project, "implement", on("bosgame"), limits, hosts)).toBe("miniforum");
    expect(pickRunHost(project, "checks", on("bosgame"), limits, hosts)).toBe("mac");
  });
  test("heavy and other phases never leave the project host", () => {
    expect(pickRunHost(project, "qa", on("bosgame"), limits, hosts)).toBe("bosgame");
    expect(pickRunHost(project, "review", on("bosgame", "bosgame"), limits, hosts)).toBeNull();
  });
  test("phase allow-list, repo reach and full hosts", () => {
    expect(
      pickRunHost(
        project,
        "implement",
        on("bosgame", "bosgame", "miniforum", "miniforum"),
        limits,
        hosts,
      ),
    ).toBeNull();
    const other = { id: "q", host: "bosgame" } as ProjectConfig;
    expect(
      pickRunHost(
        other,
        "checks",
        on("bosgame", "bosgame", "miniforum", "miniforum"),
        limits,
        hosts,
      ),
    ).toBeNull();
    expect(
      pickRunHost(
        project,
        "checks",
        on("bosgame", "bosgame", "miniforum", "miniforum"),
        limits,
        hosts,
      ),
    ).toBe("mac");
  });
});
