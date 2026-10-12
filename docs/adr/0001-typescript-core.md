# 1. TypeScript on Bun/Node for the core

- Status: accepted
- Date: 2026-10-12

## Context
The factory needs a long-running orchestrator, a dashboard, an MCP server and SDKs for agents. The maintainer's strongest stack is TypeScript.

## Decision
All first-party code is TypeScript (strict), running on Bun with Node compatibility. Schemas use Zod. The dashboard uses React.

## Consequences
One language across server, dashboard, MCP and SDK. Generated projects can use any stack; this only applies to the factory itself.
