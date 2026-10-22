# Private holdout probe contract

Scenario authors must specify observable, probe-verifiable assertions for the entire
`then` clause. Absence claims must identify instrumented surfaces and explicit
assertions: for example, stub fs/net/console before importing the software, repeatedly
call `add(2, 3)`, assert every result is 5, and assert zero intercepted calls.
Blanket claims such as “no side effects” without instrumentable checks are rejected
and regenerated. Private scenarios remain outside implementer worktrees and prompts.

Planner and judge share the same evidence criteria. An exit-zero probe that only
checks sums cannot demonstrate absence of I/O. Planner validation rejects missing
instrumentation; the judge must inspect the actual source and host output to assess
full coverage. Lexical validation is a guardrail, not proof of behavioral coverage.

Scenario preparation, probe planning, and judgment each permit one retry for model
errors or malformed responses. Exhausted planner/judge failures block as factory
tooling failures, with generic messages. Cancellation does not retry. Only hashes,
counts, exit status, timing, and model metadata are persisted, never probe source,
raw output, or judge rationale.

Code-path investigation: planner requests already resolve the selected reviewer
model, and reviewer selection excludes implementer aliases. Judgment also resolves
that reviewer. Run creation can initially label QA with the implementer fallback;
previous failure outcomes omitted the model override, leaving that misleading label.
Planner/judge failures now report the resolved reviewer model, successful holdout
receipts record the resolved judge model, and private host-probe metadata records
the planner model. Regressions cover routing and persisted failed-run labeling.
This finding is from local code and tests, not a new bosgame execution.
