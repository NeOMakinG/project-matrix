# 2. bosgame host, rootless Podman per agent run

- Status: accepted
- Date: 2026-10-12

## Context
Agents run untrusted generated code. bosgame has the most CPU and RAM but no container runtime; unprivileged user namespaces are blocked, bwrap works.

## Decision
The factory runs on bosgame. Each agent run gets its own rootless Podman container and a git worktree. bwrap is the fallback when Podman is unavailable. miniforum keeps the model gateway and device QA.

## Consequences
Needs a one-time sudo install of Podman with subuid/subgid on bosgame. Containers only reach the model gateway, the package registry and hosts allowed by the project config.
