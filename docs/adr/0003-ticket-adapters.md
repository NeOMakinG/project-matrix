# 3. Ticket adapter layer, beads by default

- Status: accepted
- Date: 2026-10-12

## Context
Projects use different trackers. The orchestrator needs one way to read and write work items.

## Decision
A `TicketStore` interface with adapters for beads (default), GitHub Issues, Linear and a markdown folder. The project picks one during init and can migrate later.

## Consequences
Orchestrator code never calls a tracker directly. Adapter features are limited to the common interface plus optional capabilities.
