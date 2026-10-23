import { expect, test } from "vitest";
import { pullRequestBranch, pullRequestTitle, untrustedMarkdown } from "./pr-text.js";

test("untrusted PR text cannot ping, link, embed or close issues", () => {
  const out = untrustedMarkdown(
    "Fixes NEO-12, closes https://github.com/o/r/issues/5 #9 @team ![x](https://t.test/p.png) <!-- hi -->‮​",
    500,
  );
  for (const bad of [
    "@team",
    " #9",
    "![",
    "](",
    "<!--",
    "Fixes NEO",
    "closes https",
    "://",
    "‮",
    "​",
  ])
    expect(out).not.toContain(bad);
  expect(out).toContain("&#64;team");
});

test("branch and title stay ASCII-safe and stable", () => {
  expect(pullRequestBranch({ id: "NEO-7", title: "Café: --force push ../../main" })).toBe(
    "matrix-NEO-7-cafe-force-push-main",
  );
  expect(pullRequestBranch({ id: "NEO-7", title: "日本語" })).toBe("matrix-NEO-7");
  expect(pullRequestTitle({ id: "NEO-7", title: "Ping @all about #3‮" })).toBe(
    "NEO-7: Ping ＠all about ＃3",
  );
});

test("manual QA checklist: fallback item, unknown surfaces dropped", async () => {
  const { pullRequestBody } = await import("./pr-text.js");
  const body = pullRequestBody({
    ticket: { id: "NEO-1", title: "x" },
    headSha: "a".repeat(40),
    evidence: [],
    linear: false,
    manualQa: { surfaces: ["android", "<script>"], criteria: [] },
  });
  expect(body).toContain("No android QA driver");
  expect(body).not.toContain("<script>");
  expect(body).toContain("- [ ] The ticket's acceptance criteria hold on the device");
});
