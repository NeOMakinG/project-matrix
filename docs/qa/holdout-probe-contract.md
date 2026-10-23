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

Runtime routing (MATRIX_RUNTIME=orca): only calls whose workdir is a ticket worktree the host
prepared through Orca (the trusted worktree registry) run as Orca tasks in the ticket's Run.
The scenario writer, probe planner and judge run in host scratch dirs, which Orca cannot
target (`selector_not_found`), so they run on the native sandbox runner instead. That is also
the secrecy-preserving choice: holdout prompts never become Orca tasks, terminals or scripts
in the ticket's Run, and never touch the implementer's worktree. A scenario-preparation
failure reports a redacted, bounded cause (runner errors only; parse errors and failed-run
summaries are never echoed because they can quote holdout text).

Presence vs absence (lexical guardrail): a negation only makes an absence claim when it is
a claim about behavior. Quoted copy (`shows "No eligible photos, add some"`) and content
after a display word in the same clause (shows/displays/renders/reads/says/message/text/
copy/label/title/banner/toast/empty state) assert that a message is present, even if the
copy contains "no" or "not". "No network request is made", "the photo is not uploaded",
"no error message is shown" and "does not show the paywall" remain absence claims and need
instrumentation (stub/spy/snapshot plus an assertion). The probe planner applies the same
detector.

Batch tolerance: a scenario that fails validation is dropped from its batch (its fixed
rejection reason is logged, never its text) as long as at least 3 valid scenarios remain
(`MIN_SCENARIOS_AFTER_DROP`). Below that, the batch is rejected and regenerated under the
normal one-retry rule. Malformed JSON, missing fields and duplicate ids still reject the batch.
