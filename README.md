# Project Matrix

A self-hostable software factory. It interviews you about the business and the stack, writes the ADRs and the backlog, then builds, reviews, tests, ships and monitors the software with AI agents, and fixes what breaks in production.

Status: design phase. See [docs/SPIKE.md](docs/SPIKE.md) and [docs/adr/](docs/adr/).

## What it does

- **Init interview:** business, product, platforms, stack and libraries, hosting, analytics, design, process and autonomy.
- **Loop:** spike, implement, checks, multi-model review, QA with receipts, merge, deploy, verify.
- **Prod loop:** errors become tickets, get fixed and are verified after deploy.
- **Knowledge:** code graph, product graph and ADRs enforced by rules.
- **Control plane:** dashboard, REST API and MCP server with scoped API keys.

## License

Apache-2.0
