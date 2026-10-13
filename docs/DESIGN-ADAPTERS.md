# Host Figma adapters: operator setup

`@matrix/design` is host-only. It uses the installed official MCP SDK 1.32.1
StreamableHTTP client, JSON Schema validator and discovered tool schemas. It does
not read a Codex/Figma OAuth cache, environment variables or current MCP session.
There is no default authorization and no model/provider requirement for capture
or comparison. No server/dashboard integration is changed in this worktree.

## Authorize and configure

1. On the host, provision **canonical absolute**, UID-owned mode-0700 directories
   for Figma artifacts, QA screenshots and, if used, credentials. Resolve macOS
   `/tmp` and `/var` aliases first: symlink components are rejected. Do not mount
   these roots into any agent. Artifacts must be outside the runner worktree.
2. Choose an explicit authorization mode. With `credential-store`, the operator
   puts an authorized bearer token in `<credentialRoot>/<credentialRef>`, an
   ordinary UID-owned mode-0600 file. The adapter only reads this explicit host
   reference. Do not extract an existing MCP OAuth token to populate it. Instead
   use an independently authorized credential or the SDK provider option below.
3. Set the **host-only** `OperatorConfig`. No new Matrix interview/runtime defaults
   are needed. Example tool bindings below are operator mappings, **not a claim
   that these exact tool names/argument names exist on your endpoint**. Obtain
   the actual inventory with your independently authorized official SDK client
   (`client.listTools()`), then configure the discovered names and input fields:

```ts
const config = {
  serverName: "figma",
  endpoint: "https://mcp.figma.com/mcp",
  authMode: "credential-store" as const,
  credentialRef: "matrix-figma-v1",
  fileKey: process.env.MATRIX_FIGMA_FILE_KEY,
  nodes: operatorSelectedFrameNodeIds,
  authenticationTool: {
    name: discoveredIdentityToolName,
    arguments: {},
    identityPath: [discoveredIdentityField],
  },
  contextTool: {
    name: discoveredContextToolName,
    fileArgument: discoveredFileArgument,
    nodeArgument: discoveredNodeArgument,
    arguments: operatorApprovedExtraScalarArguments,
  },
  screenshotTool: {
    name: discoveredScreenshotToolName,
    fileArgument: discoveredFileArgument,
    nodeArgument: discoveredNodeArgument,
  },
  downloadOrigins: operatorApprovedExactHttpsImageOrigins,
  pixelThreshold: 0.1,
  maxDiffPixelRatio: 0,
};
```

The coordinator identified this Matrix file and pages `0:1` (Foundations) and
`1:2` (Screens). These page IDs are **not proof of approved design frames**.
Inspect the authorized page context and select actual permitted frame node IDs.
Nodes are exact allowlists; permitting a page does not authorize descendants.
No factory authentication is inherited from the coordinator's WHOAMI session.

4. Call `createFigmaDesignAdapter({config, authorization, dependencies})` with:

```ts
const authorization = {
  kind: "credential-store" as const,
  operatorAuthorized: true as const,
  origin: "https://mcp.figma.com",
  credentialRef: config.credentialRef,
  root: credentialRoot,
};
const dependencies = {
  artifacts: new ArtifactStore(artifactRoot),
  qaRoot,
  comparisonScope: {
    async resolve(ctx, designs, screenshots) {
      return hostOwnedViewportRouteAssignments(ctx, designs, screenshots);
    },
  },
};
const runtime = await createFigmaDesignAdapter({config, authorization, dependencies});
```

`comparisonScope` must come from host-owned QA scenario/route/viewport assignments,
not model output or screenshot filenames. It returns `{frameUrl, qaPath}` pairs;
every design and QA screenshot must be covered, with each QA path used once.
Unassigned references/screenshots block. Different viewport dimensions fail; there
is no resizing/cropping that could conceal divergence. Optionally pair multiple
actual QA captures with one approved design when the QA scenario requires it.

Alternative explicit authorization:
- `kind: "oauth"`, `provider: OAuthClientProvider`, `authorizationOrigins: [...]`:
  inject the official SDK provider implementation with operator-authorized
  login/redirect/token persistence. Set `authMode: "oauth"` and the identical
  `oauthOrigins` in configuration. Only these HTTPS origins are reachable for
  OAuth; bearer authorization is confined to the exact MCP endpoint. A public
  PKCE provider avoids cross-origin Authorization-header client credentials,
  which this implementation denies. The host application handles authorization
  callback/`finishAuth` using SDK mechanisms; this factory does not launch a
  browser, mutate CLI state or perform hidden login flows. Missing authorization
  blocks factory construction; explicitly authorize before creating it again.
- `kind: "connected-sdk-client"`, `client: Client`: the coordinator injects an
  already connected, independently authorized official SDK client and attests
  its exact HTTPS origin/reference. Set the same `authMode`. The operator owns
  that client's transport restrictions and lifetime; the factory does not close
  it, search for credentials or infer which endpoint it is connected to.

The authentication tool must return a structured object or JSON text containing
a nonempty scalar identity at `identityPath`. Text such as "login required" is
not identity proof. Missing tools, destructive tool hints, incompatible schemas,
unauthorized calls, or absent screenshots fail closed. Extra arguments cannot
override file/node bindings. Discovery/authentication is repeated before capture,
implementation-reference verification and QA comparison. Tool-schema changes
invalidate retained evidence; recreate the adapter and runner capability and
request a fresh design/approval. Change `credentialRef` when changing principal
or authorization scope; the adapter never hashes or publishes token values.

## Wire the existing runtime

The control-plane owner supplies `runtime.figma` to `createDefaultHandlers` and
passes **unchanged** `runtime.runnerMcp` into `codexRunner({ ..., figmaMcp })` with
an existing OS-read-only Podman/bwrap executor. `hostCaptureOnly` prevents adding
a remote Figma tool to the CLI. Design gets host-captured attributed context;
implement gets approved frame URLs/content. Both explicitly treat page content
as untrusted data, not instructions. Tokens never enter runner options, prompts,
environment, sandbox mounts or receipts. No CLI-side authenticated MCP is claimed.

Create the UI classifier:

```ts
const uiContext = new HostUiContext(new SafeGitUiReader({
  trusted: trustedWorktreeRegistry,
  serverEntrypoints: hostApprovedServerEntryPaths,
  serverPackages: hostApprovedBackendDependencyNames,
}));
```

Inject this into the existing reconciler's `uiContext` option. The registry must
contain the host-recorded baseline SHA/gitdir for each ticket worktree. The reader
uses only fixed read-only Git queries, explicit trusted gitdir, disabled hooks,
filters/external diff/textconv/network/lazy-fetch, and no optional index locks.
It reads `.matrix/graph/code.json` **from the trusted baseline object**, not the
agent's current graph. UI roots and imports propagate through that graph;
server scope is proven only through explicit host-approved entrypoints and
backend dependency names (unknown external dependencies remain uncertain). Current
diff/untracked paths include both sides of a rename (rename detection disabled).
Actual changed server source is re-inspected for UI use and changed/computed
imports. Missing graphs/baselines, nested repos, nonregular paths, incomplete
imports, ignored worktree files, or unstable reads return uncertain context,
never permission to skip design. Install dependencies in host/sandbox-managed
roots outside the worktree and use existing host clean-for-checks policy; the
adapter does not clean, reset, checkout, mutate Git metadata or scan hidden creds.

## Images, provenance and comparison

MCP responses are limited to 32 MiB per HTTP response/stream with 15-second
request deadlines. Cookies, proxy authorization and off-endpoint Authorization
headers are denied before fetch. Redirects and unauthorized origins are rejected.

MCP image blocks accept PNG/JPEG base64. Signed URLs accept structured `url`,
`downloadUrl`, `downloadURL`, `screenshotUrl`, resource links, or unambiguous
text/Markdown URLs. An explicit structured screenshot URL takes precedence over
unrelated attribution links in text.
Downloads require approved exact HTTPS origins, no userinfo, no redirect,
no credentials/referrer, 15-second timeout and 16-MiB streamed byte limit.
PNG is fully decoded with CRC checks; JPEG is bounded-decoded and normalized to
PNG. The decoded limit is four million pixels. Unsupported formats, corrupt
bytes, multiple images/URLs, oversized pages and unsafe paths block.

Artifacts use SHA-256 names, exclusive no-follow writes, mode 0600, and private
host roots. Capture manifests bind project/ticket/run/commit, canonical file key,
current configuration, frame URL, context hash and screenshot hash. Verification
requires the exact retained manifest and both byte hashes, not a model receipt.
Signed URL queries/userinfo/fragments are removed from context artifacts; download
URLs are never stored in public receipts or comparison results. Errors exposed
by capture/connection are generic and do not echo URL/authentication failures.

Comparison uses the actual bundled **pixelmatch** implementation exported through
`playwright-core@1.64.0`'s `coreBundle.utils.getComparator`, with PNG/JPEG decoders
from its `utilsBundle`. This existing cached dependency is exactly pinned and
runtime-version checked; no package download or guessed pixel API is required.
Comparison records engine/version, tolerances, dimensions, mismatch details,
frame/source hashes, QA path/hash, run/commit/config scope and retained diff PNG
when present. A fixed score is never returned. It is a deterministic visual gate,
not a claim of semantic UX/accessibility equivalence; no paid SOL judge is required
or secretly invoked. Core keeps its separately scope-bound comparison receipt.

## Coordinator live-capture harness

Import `captureAuthorizedFrames` from `@matrix/design` and invoke it with the same
factory options, a real host `PhaseContext` including project/ticket/run/head SHA,
and explicitly authorized frame URLs. It executes actual capture calls and
returns clean source/hash/artifact metadata with `approved: false`. It does not
mint workflow design approvals, run a model, merge, deploy or mark-ready. Existing
phase/run/SHA-bound human approval and no-self-approval requirements still apply.
Use externally authorized store/provider/client options above; do not export
coordinator OAuth credentials to make this sandbox test pass.

Local fixtures use genuine SDK client/server exchanges (including StreamableHTTP
without sockets), explicit fake identity/token data and real image decoding/pixel
differences. They do **not** establish live Figma authorization, Matrix frame
capture, real Postgres QA, or host OS sandbox availability. Those are operator/
coordinator checks outside this restricted environment.
