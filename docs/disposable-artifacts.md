# Trusted disposable artifacts

Handover reads `matrix.config.ts` from the host-recorded BASE commit, never from
the agent's worktree or HEAD. The config must be a static object, optionally
wrapped in `defineConfig`, or a static variable exported by the generated config.
No config code is executed. Unsupported declarations fail closed.

Declare additional paths with `process.disposableArtifacts`, for example:

```ts
process: { disposableArtifacts: ["**/generated-cache/", "backend/tmp/*.json"] }
```

Globs are repository-relative: `*` and `?` match within one path segment; `**/`
matches any number of directories. A trailing `/` matches directory contents.
Absolute paths, traversal, backslashes, negation, and bracket/brace patterns
are rejected. Commit declarations on the trusted base before starting a ticket;
worktree edits cannot authorize artifacts for that ticket.

Node, React, Expo, and Tauri stacks permit nested `node_modules/`,
`coverage/`, `.turbo/`, and `*.tsbuildinfo`. Generic names such as `dist/` and
`build/` can hold authored source (`src/build/…`), so declare them explicitly with
an anchored path such as `web/dist/`. Next additionally permits
`.next/`; Expo permits `.expo/`, `android/app/build/`, and `ios/Pods/`.

Disposable artifacts absent from HEAD are excluded from the candidate tree and preserved
on disk, including during `cleanForChecks`. Undeclared ignored files refuse
handover and cleanup without deletion. Newly staged disposable files are unstaged
host-side during cleanup, without deleting their contents. Files already in HEAD are never exempt:
they remain subject to normal path protections and the complete candidate-tree
secret scan. Nested repository, symlink, and hardlink protections for committed
source remain unchanged.
