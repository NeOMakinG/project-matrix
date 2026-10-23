import { describe, expect, test } from "vitest";
import { confirmByRetry, MAX_FLAKY } from "./check-flaky.js";
import {
  checkInvocation,
  MAX_PARSE_BYTES,
  MAX_REPORT_BYTES,
  parseCheckOutput,
} from "./check-parsers.js";

const T = "tok-1";
const R = "/matrix-report";

describe("checkInvocation: structured reports go to a file", () => {
  test("eslint (direct, npm run, pnpm) writes JSON with -o; own -o or format keeps stdout", () => {
    expect(checkInvocation({ kind: "lint", cmd: ["eslint", "."] }, T)).toEqual({
      cmd: ["eslint", ".", "--format", "json", "-o", `${R}/report-${T}.json`],
      report: { name: `report-${T}.json`, maxBytes: MAX_REPORT_BYTES },
    });
    expect(
      checkInvocation({ kind: "lint", cmd: ["npm", "run", "lint"], parser: "eslint-json" }, T).cmd,
    ).toEqual(["npm", "run", "lint", "--", "--format", "json", "-o", `${R}/report-${T}.json`]);
    expect(
      checkInvocation({ kind: "lint", cmd: ["pnpm", "lint"], parser: "eslint-json" }, T).cmd.at(-2),
    ).toBe("-o");
    const own = checkInvocation({ kind: "lint", cmd: ["eslint", ".", "-o", "x.json"] }, T);
    expect(own.report).toBeUndefined();
    const stylish = checkInvocation({ kind: "lint", cmd: ["eslint", "-f", "stylish"] }, T);
    expect(stylish).toEqual({ cmd: ["eslint", "-f", "stylish"] });
  });

  test("vitest keeps the default reporter on stdout and writes JSON to the file", () => {
    const inv = checkInvocation({ kind: "test", cmd: ["vitest", "run"] }, T);
    expect(inv.cmd).toEqual([
      "vitest",
      "run",
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${R}/report-${T}.json`,
    ]);
  });

  test("node:test gets TAP to the file via NODE_OPTIONS (works through npm scripts)", () => {
    const inv = checkInvocation({ kind: "test", cmd: ["npm", "test"], parser: "node-test-tap" }, T);
    expect(inv.cmd).toEqual(["npm", "test"]);
    expect(inv.env?.NODE_OPTIONS).toBe(
      `--test-reporter=tap --test-reporter-destination=${R}/report-${T}.tap --test-reporter=spec --test-reporter-destination=stdout`,
    );
    expect(inv.report?.name).toBe(`report-${T}.tap`);
    const own = checkInvocation(
      { kind: "test", cmd: ["node", "--test", "--test-reporter=dot"] },
      T,
    );
    expect(own.env).toBeUndefined();
  });

  test("tsc and unextendable wrappers keep stdout; tokens cannot traverse paths", () => {
    expect(checkInvocation({ kind: "typecheck", cmd: ["tsc", "--noEmit"] }, T).report).toBe(
      undefined,
    );
    expect(checkInvocation({ kind: "lint", cmd: ["sh", "-c", "eslint ."] }, T).report).toBe(
      undefined,
    );
    for (const bad of ["../x", "a/b", "", "x".repeat(41), "a b"])
      expect(() => checkInvocation({ kind: "lint", cmd: ["eslint"] }, bad)).toThrow(/token/);
  });
});

describe("parseCheckOutput with a report file", () => {
  const eslintReport = (n: number) =>
    JSON.stringify([
      {
        filePath: "/work/a.ts",
        messages: Array.from({ length: n }, (_, i) => ({
          ruleId: "r",
          severity: 2,
          message: `m${i} ${"x".repeat(200)}`,
        })),
      },
    ]);

  test("a single-line report bigger than the stdout cap still parses from the file", () => {
    const text = eslintReport(19_000);
    expect(text.length).toBeGreaterThan(4 * 1024 * 1024);
    const found = parseCheckOutput(
      "eslint-json",
      { code: 1, stdout: "", stderr: "", report: { text } },
      ["/work"],
    );
    expect(found).toHaveLength(19_000);
    expect(found?.[0]).toMatch(/^a\.ts: r: m0 /);
  });

  test("missing report falls back to stdout; an unparseable report fails closed", () => {
    const stdout = eslintReport(1);
    const missing = { code: 1, stdout, stderr: "", report: { error: "no report written" } };
    expect(parseCheckOutput("eslint-json", missing, ["/work"])).toHaveLength(1);
    const junk = { code: 1, stdout, stderr: "", report: { text: "not json" } };
    expect(parseCheckOutput("eslint-json", junk)).toBeNull();
    const huge = { code: 1, stdout: "", stderr: "", report: { text: "x".repeat(10) } };
    expect(MAX_REPORT_BYTES).toBeGreaterThan(MAX_PARSE_BYTES);
    expect(parseCheckOutput("node-test-tap", huge)).toBeNull();
  });

  test("TAP report from the file, spec logs on stdout ignored", () => {
    const text = "TAP version 13\n# Subtest: a\nnot ok 1 - a\nok 2 - b\n1..2\n";
    const run = { code: 1, stdout: "✖ decoy", stderr: "", report: { text } };
    expect(parseCheckOutput("node-test-tap", run)).toEqual(["a"]);
  });
});

describe("confirmByRetry", () => {
  test("only failures that reproduce count; vanished ones are flaky", () => {
    const v = confirmByRetry(["a", "b"], { code: 1, failures: ["b", "old"] });
    expect(v).toMatchObject({ confirmed: ["b"], flaky: ["a"] });
  });

  test("new-vs-base failures only on the retry void the excuse", () => {
    expect(confirmByRetry(["a"], { code: 1, failures: ["x", "old"] }, ["old"])).toMatchObject({
      confirmed: ["a"],
      flaky: [],
    });
    expect(confirmByRetry(["a"], { code: 1, failures: ["old"] }, ["old"]).flaky).toEqual(["a"]);
  });

  test("anything the retry cannot vouch for stays confirmed", () => {
    for (const retry of [undefined, { code: 124, failures: [] }, { code: 1, failures: null }])
      expect(confirmByRetry(["a"], retry).confirmed).toEqual(["a"]);
  });

  test("more than MAX_FLAKY vanishing failures are counted as real (retry abuse)", () => {
    const many = Array.from({ length: MAX_FLAKY + 1 }, (_, i) => `t${i}`);
    expect(confirmByRetry(many, { code: 0, failures: [] })).toMatchObject({
      confirmed: many,
      flaky: [],
    });
    const few = many.slice(0, MAX_FLAKY);
    expect(confirmByRetry(few, { code: 0, failures: [] }).flaky).toEqual(few);
  });
});
