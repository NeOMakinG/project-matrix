# Contributing

- Never push to `main`. Work on a branch named `feat/…`, `fix/…` or `docs/…`.
- Open a **draft** pull request. A human marks it ready and merges.
- `bun run check` must pass locally: typecheck, Biome lint and Vitest.
- Significant decisions get an ADR in `docs/adr/` (MADR format, next free number).
- New packages go under `packages/` or `apps/`; workspace globs pick them up automatically.
- Never commit secrets, tokens or private hostnames.
