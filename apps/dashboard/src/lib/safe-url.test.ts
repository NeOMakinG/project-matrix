import { describe, expect, it } from "vitest";
import { safeHttpsUrl, safeOrcaUrl } from "./safe-url";

describe("safeHttpsUrl", () => {
  it("accepts https links on allowed hosts and subdomains", () => {
    expect(safeHttpsUrl("https://github.com/NeOMakinG/ledgerly/pull/58")).toBe(
      "https://github.com/NeOMakinG/ledgerly/pull/58",
    );
    expect(safeHttpsUrl("https://gist.github.com/x", ["github.com"])).toBe(
      "https://gist.github.com/x",
    );
  });

  it("rejects other schemes, hosts and credentials", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://github.com/x",
      "https://github.com.evil.io/x",
      "https://evilgithub.com/x",
      "https://user:pass@github.com/x",
      "//github.com/x",
      "not a url",
      42,
    ]) {
      expect(safeHttpsUrl(bad)).toBeNull();
    }
  });
});

describe("safeOrcaUrl", () => {
  it("accepts plain orca deep links only", () => {
    expect(safeOrcaUrl("orca://worktree/bosgame/pilot-142")).toBe(
      "orca://worktree/bosgame/pilot-142",
    );
    expect(safeOrcaUrl("orca://x?cmd=rm")).toBeNull();
    expect(safeOrcaUrl("javascript:orca://x")).toBeNull();
    expect(safeOrcaUrl("orca:/x")).toBeNull();
  });
});
