/**
 * Acceptance criteria split by who can verify them. A device QA agent cannot read the PR text, the
 * diff or CI, so criteria about those ("root cause written in the PR description", "a regression
 * test exists", "typecheck, lint and tests pass") are verified by Matrix itself from GitHub; the
 * agent only gets the criteria a device can show.
 */

/** "both": a code/CI criterion that also names device behaviour; each side checks its part. */
export type CriterionSource = "device" | "github" | "both";
export type CodeCriterionKind = "root-cause" | "test" | "ci";

const ROOT_CAUSE = /\broot[- ]cause\b|\b(pr|pull request)('s)? (description|body|text)\b/i;
const TEST =
  /\b(regression|unit|integration|automated|failing|jest|vitest)[- ]tests?\b|\btests? (that|which) (fails?|reproduces?|covers?)\b|\bfails? before\b.*\bpass(es)? after\b|\btests? (is|are|was|were) (added|written|updated)\b|\badds? (a )?tests?\b/i;
const CI =
  /\btype-?check(s|ing)?\b|\btsc\b|\blint(s|ing|er)?\b|\b(existing|all|unit) tests (still )?pass\b|\btests? (still )?pass(es)?\b|\btest suite\b|\bci\b|\bchecks? (are )?(green|pass(es)?)\b|\bbuild (still )?(passes|succeeds)\b/i;

/** Which code/CI fact a criterion asks about, or undefined for a device criterion. */
export function codeCriterionKind(text: string): CodeCriterionKind | undefined {
  if (ROOT_CAUSE.test(text)) return "root-cause";
  if (TEST.test(text)) return "test";
  if (CI.test(text)) return "ci";
  return undefined;
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

function regressionTest(facts: PullRequestFacts): [CodeCriterionStatus, string] {
  const tests = facts.files.filter(
    (f) => TEST_FILE.test(f.path) && f.status !== "removed" && f.additions > 0,
  );
  if (!tests.length) return ["fail", "the diff adds or changes no test file"];
  // A comment or an edit to an old case is not a regression test: an added test case is.
  const withCase = tests.filter((t) => t.patch === undefined || NEW_CASE.test(t.patch));
  if (!withCase.length) return ["fail", "the diff touches test files but adds no new test case"];
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
  return [
    "pass",
    `the diff adds test cases in ${targeted
      .map((t) => t.path)
      .slice(0, 3)
      .join(", ")}, next to the changed code (that they fail before the fix is not checked)`,
  ];
}

function ci(
  facts: PullRequestFacts,
  matrixChecks?: { ok: boolean; summary: string },
): [CodeCriterionStatus, string] {
  const base = new Set(facts.baseFailing);
  const failing = facts.checks.filter((c) => c.state === "failure" && !base.has(c.name));
  const preexisting = facts.checks.filter((c) => c.state === "failure" && base.has(c.name));
  const pending = facts.checks.filter((c) => c.state === "pending");
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
  if (pending.length)
    return [
      "unverified",
      `GitHub checks still running: ${pending
        .map((c) => c.name)
        .slice(0, 5)
        .join(", ")}`,
    ];
  if (!matrixChecks && !facts.checks.length)
    return ["unverified", "no CI result for the head commit"];
  return [
    "pass",
    `${matrixChecks ? `Matrix checks: ${matrixChecks.summary}` : "GitHub checks pass"}${facts.checks.length ? `; ${facts.checks.length - preexisting.length} GitHub check(s) ok` : ""}${notes}`,
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
    const kind = codeCriterionKind(criteria[criterion - 1] ?? "");
    if (!facts) return { criterion, status: "unverified", detail: unavailable };
    if (facts.headSha !== headSha)
      return {
        criterion,
        status: "unverified",
        detail: `GitHub reports head ${facts.headSha.slice(0, 12)}, QA ran on ${headSha.slice(0, 12)}`,
      };
    const [status, detail] =
      kind === "root-cause"
        ? rootCause(facts)
        : kind === "test"
          ? regressionTest(facts)
          : ci(facts, matrixChecks);
    return { criterion, status, detail };
  });
}
