# Trusted disposable artifacts

Handover reads `matrix.config.ts` from the host-recorded BASE commit, never from
the agent's worktree or HEAD. The config must be a static object, optionally
wrapped in `defineConfig`, or a static variable exported by the generated config.
No config code is executed. Unsupported declarations fail closed.

Only explicit trusted-BASE `process.disposableArtifacts` declarations authorize
disposables. Stack selection, tracked `package.json` files, and native build
markers never grant exemptions during handover. For example:

```ts
process: { disposableArtifacts: ["node_modules/", "app/node_modules/", "web/dist/", "backend/tmp/*.json"] }
```

Globs are repository-relative: `*` and `?` match within one path segment; `**/`
matches any number of directories. A trailing `/` matches directory contents.
Patterns starting with `**/`, absolute paths, traversal, backslashes, negation, and bracket/brace patterns
are rejected. Commit declarations on the trusted base before starting a ticket;
worktree edits cannot authorize artifacts for that ticket.

`matrix init` proposes explicit anchored declarations from generated package
manifests and tracked package/native/Next anchors. `--existing` onboarding reads
only tracked anchors, not stray untracked manifests. Package roots produce
entries such as `node_modules/`, `web/dist/`, `web/build/`, and `web/coverage/`;
Next roots add `web/.next/`; Expo/RN roots add `app/.expo/` (Expo only),
`app/android/app/build/`, and `app/ios/Pods/`. Native Podfile/Gradle anchors also
identify their respective output paths. These are generator suggestions, not
runtime defaults. Humans must review the declarations in the onboarding PR and
commit them on the trusted base before handing over a ticket.

Authored `src/coverage/secret.ts` is not disposable, even when `src/package.json`
is tracked, unless the reviewed BASE declaration explicitly covers it. Review
generator suggestions for packages under authored-source directories carefully.

Disposable artifacts absent from HEAD are excluded from the candidate tree and preserved
on disk, including during `cleanForChecks`. Undeclared ignored files refuse
handover and cleanup without deletion. Newly staged disposable files are unstaged
host-side during cleanup, without deleting their contents. Files already in HEAD are never exempt:
they remain subject to normal path protections and the complete candidate-tree
secret scan. Nested repository, symlink, and hardlink protections for committed
source remain unchanged.
