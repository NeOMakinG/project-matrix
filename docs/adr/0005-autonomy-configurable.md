# 5. Autonomy is a per-project setting

- Status: accepted
- Date: 2026-10-12

## Context
Users trust agents differently, and trust changes over time.

## Decision
The init interview asks how merges and deploys happen: human merge of draft PRs, gated auto-merge through a merge queue, or fully autonomous. The setting can change at any time from the dashboard, CLI or API, per project and per phase.

## Consequences
Every merge and deploy step checks the current autonomy setting at run time. Changes are logged.
