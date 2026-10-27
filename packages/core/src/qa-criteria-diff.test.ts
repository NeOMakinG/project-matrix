import { describe, expect, test } from "vitest";
import { classifyCriteria, type PullRequestFacts, verifyCodeCriteria } from "./qa-criteria.js";

const criteria = [
  "README.md `## Live` Dashboard line contains `https://dashboard.deltahealth.fit` and still contains `https://eagleray-dashboard.netlify.app`.",
  "No file other than README.md changes.",
  "The login screen shows the new logo.",
];
const facts = (files: PullRequestFacts["files"]): PullRequestFacts => ({
  headSha: "h",
  body: "",
  files,
  checks: [],
  baseFailing: [],
});
const readme = {
  path: "README.md",
  status: "modified",
  additions: 1,
  patch:
    "@@ -3,3 +3,3 @@\n ## Live\n-- Dashboard: https://eagleray-dashboard.netlify.app\n+- Dashboard: https://dashboard.deltahealth.fit (Netlify fallback: https://eagleray-dashboard.netlify.app)",
};

describe("repository-file criteria", () => {
  test("file criteria are Matrix's to verify; UI ones stay device", () => {
    expect(classifyCriteria(criteria)).toEqual(["github", "github", "device"]);
  });
  test("verified from the PR diff", () => {
    const r = verifyCodeCriteria(criteria, [1, 2], facts([readme]), "h");
    expect(r.map((x) => x.status)).toEqual(["pass", "pass"]);
  });
  test("an extra changed file fails; a missing string is unverified", () => {
    const extra = facts([readme, { path: "netlify.toml", status: "modified", additions: 1 }]);
    expect(verifyCodeCriteria(criteria, [2], extra, "h")[0]?.status).toBe("fail");
    const other = facts([{ ...readme, patch: "@@\n+- Dashboard: https://x.example" }]);
    expect(verifyCodeCriteria(criteria, [1], other, "h")[0]?.status).toBe("unverified");
  });
  test("nested files are not the named root file; unquoted content is unverified", () => {
    const nested = facts([
      readme,
      { path: "apps/api/README.md", status: "modified", additions: 1 },
    ]);
    expect(verifyCodeCriteria(criteria, [2], nested, "h")[0]?.status).toBe("fail");
    const plain = ["README.md contains the new domain."];
    expect(verifyCodeCriteria(plain, [1], facts([readme]), "h")[0]?.status).toBe("unverified");
  });
});
