/**
 * Acceptance criteria split by who can verify them. A device QA agent cannot read the PR text, the
 * diff or CI, so criteria about those ("root cause written in the PR description", "a regression
 * test exists", "typecheck, lint and tests pass") are verified by Matrix itself from GitHub; the
 * agent only gets the criteria a device can show.
 */

/** "both": a code/CI criterion that also names device behaviour; each side checks its part. */
export type CriterionSource = "device" | "github" | "both";
export type CodeCriterionKind = "root-cause" | "test" | "ci" | "diff";

const ROOT_CAUSE = /\broot[- ]cause\b|\b(pr|pull request)('s)? (description|body|text)\b/i;
const TEST =
  /\b(regression|unit|integration|automated|failing|jest|vitest)[- ]tests?\b|\btests? (that|which) (fails?|reproduces?|covers?)\b|\bfails? before\b.*\bpass(es)? after\b|\btests? (is|are|was|were) (added|written|updated)\b|\badds? (a )?tests?\b/i;
const CI =
  /\btype-?check(s|ing)?\b|\btsc\b|\blint(s|ing|er)?\b|\b(existing|all|unit) tests (still )?pass\b|\btests? (still )?pass(es)?\b|\btest suite\b|\bci\b|\bchecks? (are )?(green|pass(es)?)\b|\bbuild (still )?(passes|succeeds)\b/i;

/** A repository file named in a criterion (`README.md`, `apps/api/src/x.ts`). */
const FILE_PATH =
  /(?<![\w/.-])(?:[\w.-]+\/)*[\w-]+\.(?:md|mdx|txt|json|ya?ml|toml|[cm]?[jt]sx?|py|go|rs|sql|css|html|sh)(?![\w.-])/gi;
/** "README.md ... contains `x`", "no file other than README.md changes", "only X changes". */
const DIFF =
  /\b(contains?|no (other )?files?( other than| besides| except)?|only\b.*\b(changes?|changed|modified|touched))\b/i;

function namedFiles(text: string): string[] {
  return [...new Set((text.match(FILE_PATH) ?? []).filter((f) => !/^https?:/i.test(f)))];
}

/** Every code/CI fact a criterion asks about (empty for a device criterion). */
export function codeCriterionKinds(text: string): CodeCriterionKind[] {
  return [
    ...(ROOT_CAUSE.test(text) ? (["root-cause"] as const) : []),
    // "root cause ... with proof (log, trace or failing test)": the test is one kind of proof,
    // checked by the root-cause rule, not a separate requirement.
    ...(TEST.test(ROOT_CAUSE.test(text) ? text.replace(/\([^)]*\)/g, "") : text)
      ? (["test"] as const)
      : []),
    ...(CI.test(text) ? (["ci"] as const) : []),
    ...(namedFiles(text).length && DIFF.test(text) ? (["diff"] as const) : []),
  ];
}

/** The first code/CI fact a criterion asks about, or undefined for a device criterion. */
export function codeCriterionKind(text: string): CodeCriterionKind | undefined {
  return codeCriterionKinds(text)[0];
}

/** Words for something a person does or sees on the device. */
const DEVICE_CUE =
  /\b(tap(s|ped|ping)?|press(es|ed|ing)?|click(s|ed|ing)?|swipe[sd]?|swiping|scroll(s|ed|ing)?|drag(s|ged|ging)?|open(s|ed|ing)?|launch(es|ed|ing)?|navigat(e|es|ed|ing)|screens?|sheet|button|shows?|showing|display(s|ed)?|visible|appears?|renders?|user sees|on (the )?(device|phone|emulator))\b/i;

export function classifyCriteria(criteria: readonly string[]): CriterionSource[] {
  return criteria.map((c) =>
    !codeCriterionKind(c) ? "device" : DEVICE_CUE.test(c) ? "both" : "github",
  );
}

/** What GitHub (and Matrix's own checks phase) says about the PR at the QA'd head. */
export interface PullRequestFacts {
  /** The head SHA GitHub reports for the PR; must equal the QA'd head. */
  headSha: string;
  body: string;
  /** `patch`: the file's unified diff as GitHub returns it (absent for big or binary files). */
  files: { path: string; status: string; additions: number; patch?: string }[];
  /** Check runs and commit statuses on the head SHA. */
  checks: { name: string; state: "success" | "failure" | "pending" | "neutral" }[];
  /** Names of checks failing on the base branch's tip: failing there too means pre-existing. */
  baseFailing: string[];
}

export type CodeCriterionStatus = "pass" | "fail" | "unverified";

export interface CodeCriterionResult {
  /** 1-based criterion number. */
  criterion: number;
  status: CodeCriterionStatus;
  detail: string;
  /** The criterion also names device behaviour: the device agent checks that half. */
  alsoDevice?: boolean;
}

const TEST_FILE =
  /(^|\/)(__tests__|tests?|spec)\/|[._-](test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rs)$|(^|\/)test_[^/]+\.py$/i;

/** `DaySheetScreen.strip.test.tsx` -> `daysheetscreen`, `test_parser.py` -> `parser`. */
const stem = (path: string) =>
  (path.split("/").pop() ?? "")
    .split(".")[0]!
    .replace(/^test_|_test$|[-_](test|spec)$/i, "")
    .toLowerCase();

const dir = (path: string) => path.split("/").slice(0, -1).join("/");

/** A "Root cause" heading or label, then its text up to the next heading. */
function rootCauseSection(body: string): string | undefined {
  const m = body.match(
    /(^|\n)[ \t]*(#{1,6}[ \t]*)?(\*\*)?root[- ]cause(\*\*)?[ \t]*:?(\*\*)?[ \t]*(.*)/i,
  );
  if (!m) return undefined;
  const rest = body.slice((m.index ?? 0) + m[0].length);
  const end = rest.search(/\n[ \t]*#{1,6}[ \t]/);
  return `${m[6] ?? ""}\n${end < 0 ? rest : rest.slice(0, end)}`.trim();
}

const PROOF =
  /\b(test|tests|log|logs|logcat|trace|stack|repro(duced|duction)?|fails? before|failing|screenshot|profil(e|er|ing))\b|`[^`\n]+`|\.[cm]?[jt]sx?\b|:\d+\b/i;

function rootCause(facts: PullRequestFacts): [CodeCriterionStatus, string] {
  const section = rootCauseSection(facts.body);
  if (!section) return ["fail", "the PR description has no root cause section"];
  if (section.replace(/\s+/g, " ").length < 40)
    return ["fail", "the PR description's root cause section is too short to explain anything"];
  if (!PROOF.test(section))
    return ["fail", "the PR description's root cause names no proof (test, log, trace or code)"];
  return ["pass", "the PR description has a root cause section with proof"];
}

/** An added line that declares a test case (JS/TS, Python, Go, Rust, Kotlin/Java, Swift). */
const NEW_CASE =
  /^\+(?!\+\+)\s*(?:(?:it|test|describe)(?:\.\w+)?\s*\(|(?:async\s+)?def test_\w*|func Test\w*|#\[(?:tokio::)?test\]|@Test\b|func test\w*)/m;

/** The added lines of a unified diff. */
const added = (patch: string) =>
  patch
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .join("\n");

const ASSERTION = /\b(expect|assert\w*|should|XCTAssert\w*|require\.\w+|t\.(Error|Fatal)\w*)\b/;

/**
 * PASS needs evidence for each half of "fails before, passes after": an added test case with an
 * assertion next to the changed code, the PR description naming that test as the proof (the
 * author's claim it failed before), and green tests on the head (it passes after). Anything the
 * evidence cannot establish is unverified (a human looks), never a silent pass.
 */
function regressionTest(
  facts: PullRequestFacts,
  matrixChecks?: { ok: boolean; summary: string },
): [CodeCriterionStatus, string] {
  const tests = facts.files.filter(
    (f) => TEST_FILE.test(f.path) && f.status !== "removed" && f.additions > 0,
  );
  if (!tests.length) return ["fail", "the diff adds or changes no test file"];
  // A comment, a placeholder or an edit to an old case is not a regression test.
  const withCase = tests.filter(
    (t) => t.patch !== undefined && NEW_CASE.test(t.patch) && ASSERTION.test(added(t.patch)),
  );
  if (!withCase.length)
    return tests.some((t) => t.patch === undefined)
      ? ["unverified", "GitHub shows no diff for the changed test files (too large or binary)"]
      : ["fail", "the diff touches test files but adds no test case with an assertion"];
  const sources = facts.files.filter((f) => !TEST_FILE.test(f.path) && /\.[a-z]+$/i.test(f.path));
  const targeted = withCase.filter((t) =>
    sources.some((s) => {
      const a = stem(t.path);
      const b = stem(s.path);
      return (
        (a.length > 3 && b.length > 3 && (a.startsWith(b) || b.startsWith(a))) ||
        dir(t.path) === dir(s.path)
      );
    }),
  );
  // A test elsewhere may still be the right one; Matrix cannot tell from paths: not a FAIL.
  if (!targeted.length)
    return [
      "unverified",
      `test files changed (${tests
        .map((t) => t.path)
        .slice(0, 3)
        .join(", ")}) but none sits next to or is named after a changed source file`,
    ];
  const names = targeted.map((t) => t.path).slice(0, 3);
  const body = facts.body.toLowerCase();
  const cited = targeted.some((t) => {
    const file = (t.path.split("/").pop() ?? "").toLowerCase();
    const base = file.split(".")[0] ?? file;
    return body.includes(file) || (base.length > 8 && body.includes(base));
  });
  if (!cited)
    return [
      "unverified",
      `the diff adds test cases in ${names.join(", ")}, but the PR description does not name them as the proof that fails before the fix`,
    ];
  const testRuns = facts.checks.filter((c) => /\b(test|tests|ci)\b/i.test(c.name));
  if (testRuns.some((c) => c.state === "failure" && !facts.baseFailing.includes(c.name)))
    return ["fail", "a test run fails on the head"];
  if (testRuns.some((c) => c.state === "pending"))
    return ["unverified", "test runs are still going on the head"];
  const green = matrixChecks?.ok || testRuns.some((c) => c.state === "success");
  if (!green) return ["unverified", `no passing test run on the head for ${names.join(", ")}`];
  return [
    "pass",
    `the diff adds test cases in ${names.join(", ")} next to the changed code, the PR description cites them and tests pass on the head`,
  ];
}

/** A check that runs lint, typecheck, tests or a build (by its name). */
const CI_CHECK =
  /lint|type[- ]?check|typescript|tsc|test|\bci\b|build|biome|eslint|vitest|jest|e2e|playwright|detox|maestro|cypress/i;
/** Checks that only deploy or preview the site (Netlify/Vercel/Pages rules). */
const DEPLOY_CHECK =
  /netlify|vercel|deploy|preview|header rules|redirect rules|pages changed|cloudflare pages/i;

function ci(
  facts: PullRequestFacts,
  matrixChecks?: { ok: boolean; summary: string },
): [CodeCriterionStatus, string] {
  const base = new Set(facts.baseFailing);
  // Only checks that run what the criterion names count; a failing deploy preview is not
  // "typecheck, lint and tests" and is only listed.
  const relevant = (name: string) => CI_CHECK.test(name);
  const unrelated = facts.checks.filter(
    (c) => c.state === "failure" && !relevant(c.name) && DEPLOY_CHECK.test(c.name),
  );
  // A failing or running check Matrix cannot place is not evidence either way: unverified.
  const unknown = facts.checks.filter(
    (c) =>
      !relevant(c.name) &&
      !DEPLOY_CHECK.test(c.name) &&
      (c.state === "pending" || (c.state === "failure" && !base.has(c.name))),
  );
  const failing = facts.checks.filter(
    (c) => c.state === "failure" && relevant(c.name) && !base.has(c.name),
  );
  const preexisting = facts.checks.filter(
    (c) => c.state === "failure" && relevant(c.name) && base.has(c.name),
  );
  const pending = facts.checks.filter((c) => c.state === "pending" && relevant(c.name));
  const other = unrelated.length
    ? `; failing checks unrelated to lint, typecheck or tests (not counted): ${unrelated
        .map((c) => c.name)
        .slice(0, 5)
        .join(", ")}`
    : "";
  const notes = preexisting.length
    ? `; failing on the base branch too (pre-existing): ${preexisting
        .map((c) => c.name)
        .slice(0, 5)
        .join(", ")}`
    : "";
  if (matrixChecks && !matrixChecks.ok)
    return ["fail", `Matrix checks failed: ${matrixChecks.summary}`];
  if (failing.length)
    return [
      "fail",
      `GitHub checks failing on the head and not on the base branch: ${failing
        .map((c) => c.name)
        .slice(0, 5)
        .join(", ")}`,
    ];
  if (unknown.length)
    return [
      "unverified",
      `checks Matrix cannot classify are failing or running: ${unknown
        .map((c) => c.name)
        .slice(0, 5)
        .join(", ")}`,
    ];
  if (pending.length)
    return [
      "unverified",
      `GitHub checks still running: ${pending
        .map((c) => c.name)
        .slice(0, 5)
        .join(", ")}`,
    ];
  // Something must actually have run the checks: Matrix's checks phase, or a GitHub check that
  // looks like lint/typecheck/tests/build (a deploy preview alone proves nothing).
  const covering = facts.checks.filter((c) => c.state === "success" && relevant(c.name));
  if (!matrixChecks?.ok && !covering.length)
    return ["unverified", "no lint, typecheck or test run is reported for the head commit"];
  return [
    "pass",
    `${matrixChecks ? `Matrix checks: ${matrixChecks.summary}` : "GitHub checks pass"}${covering.length ? `; ${covering.length} GitHub check(s) ok` : ""}${notes}${other}`,
  ];
}

/** Verifies the code/CI criteria (`numbers` are 1-based) against GitHub facts for `headSha`. */
export function verifyCodeCriteria(
  criteria: readonly string[],
  numbers: readonly number[],
  facts: PullRequestFacts | undefined,
  headSha: string,
  matrixChecks?: { ok: boolean; summary: string },
  unavailable = "GitHub facts for the PR were not available",
): CodeCriterionResult[] {
  return numbers.map((criterion) => {
    const kinds = codeCriterionKinds(criteria[criterion - 1] ?? "");
    if (!facts) return { criterion, status: "unverified", detail: unavailable };
    if (facts.headSha !== headSha)
      return {
        criterion,
        status: "unverified",
        detail: `GitHub reports head ${facts.headSha.slice(0, 12)}, QA ran on ${headSha.slice(0, 12)}`,
      };
    // Every part the criterion names must hold: the worst part decides.
    const parts = (kinds.length ? kinds : (["ci"] as const)).map((kind) =>
      kind === "root-cause"
        ? rootCause(facts)
        : kind === "test"
          ? regressionTest(facts, matrixChecks)
          : kind === "diff"
            ? diffFacts(criteria[criterion - 1] ?? "", facts)
            : ci(facts, matrixChecks),
    );
    const status: CodeCriterionStatus = parts.some(([s]) => s === "fail")
      ? "fail"
      : parts.some(([s]) => s === "unverified")
        ? "unverified"
        : "pass";
    return { criterion, status, detail: parts.map(([, d]) => d).join("; ") };
  });
}

/**
 * Repository-file criteria from the PR diff: "no file other than X changes" holds when every
 * changed path is named; "X contains `s`" holds when `s` is on an added or context line of X's
 * patch (absent from the patch = unverified, never a guess either way).
 */
function diffFacts(text: string, facts: PullRequestFacts): [CodeCriterionStatus, string] {
  const named = namedFiles(text);
  const changed = facts.files.map((f) => f.path);
  if (/\b(no (other )?files?|only)\b/i.test(text) && /\bchang|modif|touch/i.test(text)) {
    const extra = changed.filter((p) => !named.includes(p));
    if (extra.length) return ["fail", `the PR also changes ${extra.slice(0, 5).join(", ")}`];
    if (!/\bcontains?\b/i.test(text)) return ["pass", `the PR changes only ${changed.join(", ")}`];
  }
  const needles = [...text.matchAll(/`([^`]{3,200})`/g)]
    .map((m) => m[1] as string)
    .filter((n) => !named.includes(n) && !/^#+\s/.test(n));
  if (!needles.length) return ["unverified", "no `quoted` text to look for in the diff"];
  // One content assertion per criterion: several named files cannot be attributed reliably.
  if (named.length !== 1) return ["unverified", `content of several files (${named.join(", ")})`];
  const file = facts.files.find((f) => f.path === named[0]);
  if (!file?.patch) return ["unverified", `no diff of ${named.join(", ")} to read`];
  const lines = file.patch.split("\n").filter((l) => !l.startsWith("-"));
  const missing = needles.filter((n) => !lines.some((l) => l.includes(n)));
  return missing.length
    ? ["unverified", `${file.path} diff does not show ${missing.join(", ")}`]
    : ["pass", `${file.path} diff contains ${needles.join(", ")}`];
}
