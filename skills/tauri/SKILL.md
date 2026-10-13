---
name: tauri
description: Quality rules for Tauri v2 desktop apps in a Matrix project — Rust commands, capabilities and permissions, IPC, updater and signing. Use when writing or reviewing desktop code under apps/desktop.
---

# Tauri v2 quality

## Security model

- Capabilities in `src-tauri/capabilities/` grant the minimum: no wildcard `fs` or `shell` permissions (ADR rule). Scope filesystem access to app directories.
- Keep the CSP in `tauri.conf.json` strict; no remote scripts.
- The webview is untrusted: every `#[tauri::command]` validates its arguments and checks authorization like an HTTP endpoint.

## Commands and IPC

- Commands are small, typed (`serde` structs), and return `Result<T, String>` or a serializable error enum.
- Long work runs async or on a background thread; never block the main thread.
- Frontend calls go through one typed wrapper module around `invoke`, not scattered string command names.

## Updates and releases

- The updater verifies signatures with the public key in `tauri.conf.json`; the private key lives only in CI secrets.
- macOS builds are signed and notarized, Windows builds Authenticode-signed (see the signing ADR).
- Release artifacts and `latest.json` are produced by CI, never by an agent's machine.

## Quality gates

- `cargo check` and `cargo clippy -- -D warnings` on `src-tauri`; `cargo fmt --check`.
- UI is tested like the web app (Vitest + Playwright against `vite dev`).
