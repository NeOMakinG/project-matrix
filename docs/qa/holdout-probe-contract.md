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

Presence vs absence (lexical guardrail, erring towards absence): a negation (no, none,
nothing, never, without, not/n't + word, unchanged, ...) is an absence claim unless it is
displayed copy: inside quotes (`shows "No eligible photos, add some"`), or introduced directly
by a display verb, optionally naming the element (`shows an empty-state message no eligible
photos, add some`, `reads: no photos yet`), with no behavior verb after it in the clause
("shows nothing is uploaded" is still an absence claim). "No network request is made", "the photo is not uploaded",
"no error message is shown" and "does not show the paywall" remain absence claims and need
instrumentation (stub/spy/snapshot plus an assertion). The probe planner applies the same
detector.

Batch tolerance: a scenario that fails validation is dropped from its batch (its fixed
rejection reason is logged, never its text) as long as at least 3 valid scenarios remain
(`MIN_SCENARIOS_AFTER_DROP`); a scenario missing given/when/then is dropped the same way.
Below that, the batch is rejected and regenerated under the normal one-retry rule. Malformed
JSON, a bad scenario count and duplicate ids still reject the batch.

Committed snapshot: probes run on a copy of the committed tree. Binary assets (images, media,
models, fonts, archives) and any file above 4 MiB are materialized as empty placeholder files,
so imports still resolve while the snapshot stays within memory limits; the planner is told how
many placeholders exist. A QA preparation failure surfaces its Matrix-authored cause (redacted,
bounded) through `FactoryToolingError.operatorCause`; driver messages without it stay generic.

Review lanes: review sandboxes have no git metadata by design. The host computes base,
merge-base and head SHAs, the changed files, the diff, ADRs/architecture docs and the derived
code graph, and passes them in the lane prompt. Lanes report environment limitations as
`toolingNotes`; findings whose whole title is an environment-only shape (no code location, no
changed file named) are reclassified as tooling notes host-side and never block.
