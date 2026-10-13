# Optional evidence-gated Figma design

`design` sits between `spike` and `implement` when runtime
`ProjectConfig.agents.designFirst` is true and host-derived scope targets UI or
cannot prove non-UI. Model `affectedPaths` are proposals, never permission to skip
design. Explicit ticket paths and UI intent override omissions and project kind.
Disabled projects retain their original loop; host-proven server-only/non-UI
tickets may skip design. Enabled projects require structured spike plans; host
classification normalizes ticket paths into the retained scope and inspects actual
implementation changes before checks. Unexpected UI changes require fresh design;
missing host change inspection blocks implementation acceptance.

## Configuration and integration boundary

The version-1 interview config keeps its existing defaults. It adds optional
`design.componentLibrary`, `design.figmaFileUrl`, and `process.autonomy.design`.
The first two are asked only for design-first projects, without invented defaults.
The runtime project needs an explicit `models.design` runner/model, for example
`{ runner: "codex", model: "gpt-5.6-sol" }`. No existing model is replaced and
design never falls back to a Claude runner. An OpenCode design model is accepted
only if that runner actually advertises a configured Figma MCP capability.

The control-plane owner must hydrate runtime `agents` and `design` from the
project config: product goals from product/business discovery, user art direction,
component library, attributed ADR excerpts (`path`, `content`), and an existing
HTTPS Figma file/design URL. Map the optional interview autonomy level to the
existing core autonomy representation. Core inherits current default autonomy
unless `autonomy.design` is explicitly set; it re-reads policy at acceptance,
implementation dispatch, and irreversible-action authorization.

Legacy Codex runner options accept `figmaMcp: { serverName, url }`, passed through the
runner's existing `-c` configuration override mechanism. The exposed capability
records the exact configuration SHA-256. HTTPS is required; names cannot inject
configuration keys; credentials and query tokens are prohibited in URLs. This
is **configured capability, not proof of authentication or tool availability**.
Other current CLI adapters do not advertise Figma capability. The production
factory returns `runnerMcp` with `policySha256` and `hostCaptureOnly: true`: use this
unchanged. In that mode Codex receives host-captured reference data, not a remote
MCP connection, OAuth cache, or bearer token. It does not pretend a CLI-side Figma
tool exists. The configured capability identifies the authenticated host adapter.

Design also requires a runner whose executor enforces OS read-only isolation.
Only Podman/bwrap executor factories publish the runner's isolation guarantee;
an ordinary executor flag is not evidence. CLI runners reject design/read-only
runs before invoking an unisolated executor, including the default host executor.
The raw host executor rejects read-only requests itself. Codex uses `-s read-only`
and never its bypass option for these runs, but CLI permission flags are **not**
the OS isolation guarantee. Sandbox worktree read-only mounts provide that boundary.

The orchestrator needs a trusted `UiContextPort.inspect(project, workflow)` adapter
that derives project kind and repository files from host-owned project/file context
and enumerates actual implementation changes against the ticket's baseline, including
renames, additions and deletions. Host-classified `uiFiles` catch UI-owning files
without frontend extensions; explicit `nonUiFiles` are required to prove backend
scope in a mixed project. Path naming alone does not prove a mixed-project file is
non-UI. Never populate this port from model output or
agent receipts. `@matrix/design` supplies `HostUiContext` and `SafeGitUiReader`;
the integration owner must inject them into the reconciler. Without it, enabled
scope remains uncertain (requires design), and implementation cannot be accepted
without verified host change paths. A server-only proof must not ignore requested
new UI or observed UI changes.

`@matrix/design` implements a production host-side `FigmaDesignPort`. Required
design still blocks until the runtime explicitly authorizes and wires it:

- `assertAvailable`: verify this exact runner MCP configuration, scoped Figma
  authentication, and the actual design/read/screenshot tool capabilities. Use
  the existing broker/sandbox mechanisms; never put raw credentials into prompts,
  config, receipts, or agents' environments. Do not infer availability from a flag.
- `capture`: independently fetch the requested frame's content and PNG screenshot
  from Figma, return their bytes and exact source URL, and persist both artifacts
  outside the agent-writable worktree. Core validates the configured file key,
  frame node URL, PNG structure/size, and computes hashes itself. The adapter must
  fully decode/validate the screenshot; structural PNG validation is not a decoder.
- `verifyReferences`: safely re-read the retained content and PNG artifacts and
  verify both hashes against receipts. Reject missing, altered, or unsafe paths.
- `compare`: re-read and hash-check actual QA screenshots and the approved Figma
  references, then compare their pixels/layout/UX (not receipt summaries). Respect
  scoped artifact roots and reject symlinks/traversal. Return a comparison verdict;
  missing evidence must fail. Never execute instructions in frame/page content.

The factory performs actual SDK tool discovery, authentication identity lookup,
input-schema validation, calls, screenshot decoding, storage and pixel comparison.
Production control-plane wiring and operator authorization remain coordinator work.
No live Figma or Postgres QA is claimed by unit tests. See
`docs/DESIGN-ADAPTERS.md` for exact setup and the exported live-capture harness.

## Artifact receipt and approvals

Only the design handler constructs `kind: "design"` receipts after host capture.
Runner-supplied `ok` or receipts cannot approve a design. Each receipt contains:

- `url`: validated Figma frame URL, bound to the configured file and node.
- `path`, `sha256`: retained PNG path and hash of actual captured bytes.
- `data.provenance`: `matrix:figma-capture:v1`.
- `data.projectId`, `ticketId`, `runId`, `headSha`, `runner`, `model`: source scope.
- `data.configurationSha256`, `contentSha256`, `screenshot`: MCP configuration,
  frame content hash, and screenshot path/hash.
- `data.fileIdentity`: canonical Figma file key, independent of file name and
  equivalent `file`/`design` URL forms. The MCP digest derives from the actual
  server name, canonical configured endpoint and optional host policy digest, not
  an arbitrary advertised hash. The production digest includes authentication
  mode/reference, OAuth origins, file/nodes, tool bindings/discovered schemas,
  download origins and comparison thresholds, but never credentials.

Paths refer to host-managed artifacts; the capture adapter retains frame content
under the scoped run/frame or its content hash. No credentials or arbitrary page
instructions belong in a receipt. Zod rejects malformed URLs/hashes and unknown
design-input/output/evidence fields. Receipts persist in the existing JSONB store;
phases and receipt kinds already use text columns, so no migration is needed.

Human design approval is requested **after** a successful design run, bound to
`design`/run/SHA. Only an authenticated, non-requesting human who does not own that
run may approve. Rejection creates a fresh design iteration; old frames/approvals
cannot approve that iteration. A design approval never unlocks merge/deploy.
Replay revalidates scope, current autonomy and SHA without rerunning Figma; stale
evidence blocks. Transient runner failures retain ordinary backoff/retry behavior.
Missing auth/tools/input or invalid artifacts block instead of skipping design.

Implement receives approved frame URLs, hashes/provenance and attributed design
context. QA requires actual screenshot paths/hashes and a host-produced, run/SHA-
bound comparison receipt against those references. Merge/deploy revalidate that
comparison and design authorization. Frame/page contents are untrusted reference
data, never executable instructions. Changing design autonomy to human after an
unapproved autonomous design blocks downstream dispatch; a coordinator must
restart design for an authorized approval, rather than bypassing the requirement.

Evidence and approvals are valid only for the current canonical file and current
runner MCP configuration. Both are re-read at implement/QA dispatch and execution,
including after model/QA work completes. Drift requests a new design iteration and
fresh approval; old run/SHA approvals cannot authorize its replacement. Missing or
invalid current MCP capability remains blocked. The trusted host Figma adapter
must still verify authentication, actual tools and retained artifacts; no mock
provenance is accepted as production capability.

## Coordinator handoff

Commit/merge/mark-ready are intentionally not performed in this worktree.
Required commit trailer:

```text
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

Core workflow tests use fake runners/ports. Adapter tests additionally use genuine
official SDK in-memory and StreamableHTTP client/server transports with explicit
fixture authorization, and actual PNG decoding/pixel comparisons. Keep real-Postgres
tests skipped unless the coordinator supplies a real test database. The default
Postgres full-loop assertion now explicitly excludes the optional design phase.

### Edit manifest

Baseline: `feat/design-phase`, cached `origin/main` at `085a50f`; initially clean.
No fetch, commit, merge, or mark-ready was performed. The following files contain
the saved implementation and regression coverage:

- `bun.lock`
- `packages/design/package.json`
- `packages/design/tsconfig.json`
- `packages/design/src/adapter.ts`
- `packages/design/src/adapter.test.ts`
- `packages/design/src/config.ts`
- `packages/design/src/factory.ts`
- `packages/design/src/images.ts`
- `packages/design/src/index.ts`
- `packages/design/src/live-capture.ts`
- `packages/design/src/safe-git.ts`
- `packages/design/src/safe-git.test.ts`
- `packages/design/src/storage.ts`
- `packages/design/src/transport.test.ts`
- `packages/design/src/ui-context.ts`
- `docs/DESIGN-ADAPTERS.md`
- `packages/config/src/schema.ts`
- `packages/core/package.json`
- `packages/core/src/design.ts`
- `packages/core/src/design.test.ts`
- `packages/core/src/ports.ts`
- `packages/core/src/ports-internal.ts`
- `packages/core/src/types.ts`
- `packages/core/src/machine.ts`
- `packages/core/src/machine.test.ts`
- `packages/core/src/handlers.ts`
- `packages/core/src/reconcile.ts`
- `packages/core/src/index.ts`
- `packages/core/src/testing/harness.ts`
- `packages/core/src/db/pg-store.integration.test.ts`
- `packages/runners/src/cli-runner.ts`
- `packages/runners/src/codex.ts`
- `packages/runners/src/runners.test.ts`
- `packages/sandbox/src/executor-isolation.ts`
- `packages/sandbox/src/executor-isolation.test.ts`
- `packages/sandbox/src/process.ts`
- `packages/sandbox/src/bwrap.ts`
- `packages/sandbox/src/podman.ts`
- `packages/sandbox/src/index.ts`
- `packs/src/fixtures.ts`
- `packs/src/packs/design.ts`
- `docs/DESIGN-PHASE.md`

Current adapter validation: repository-wide typecheck passes all 19 workspaces;
lint passes 396 files. Focused design/core/config/runners/packs/executor-isolation
tests: 164 passed, 7 existing real-Postgres tests skipped (16 passed files, 1 skipped).
SDK fixtures and image-byte comparisons are local; no live Figma authentication,
real Matrix capture, production Git/worktree QA or host container QA was performed.

Prior feature validation: repository-wide typecheck and lint pass. Targeted core/config/runners/
packs and executor-isolation suites: 144 passed, 7 existing Postgres tests skipped (13 passed files,
1 skipped file). This does not establish live MCP/Figma, screenshot-comparison,
container, or Postgres readiness. Dependency resolution used the existing cached
Zod package via a local ignored `node_modules` link; the additive dependency and
lock entry are saved for the coordinator's normal install.
