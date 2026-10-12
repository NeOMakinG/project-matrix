---
name: matrix-init
description: Start a new project (or onboard an existing repo) with Project Matrix by running its init interview conversationally. Use when the user wants to start, bootstrap or scaffold a project, or set up the software factory on a codebase.
---

# Matrix init interview

Drive `matrix init` as a conversation. The interview is a design tree: each round contains every question that can be answered now, each with a recommended answer and a reason.

## Loop

1. Keep answers in `.matrix/answers.json` inside the target directory (start with `{}`).
2. Get the next round:

   ```
   matrix init next --answers .matrix/answers.json
   ```

   It prints `{ "done": boolean, "round": [{ id, pack, prompt, kind, options, recommended, rationale }] }`.
3. Ask the whole round in one message, grouped by pack. For each question show the recommended answer and its rationale, and number the options so the user can reply tersely ("all recommended except 3 → b").
4. Look facts up instead of asking when you can: read the repo, package.json, existing docs. For an existing codebase use `--existing`, which infers answers from dependencies and files.
5. Write the user's answers into `.matrix/answers.json` (question id → value; multiselect and list answers are arrays) and repeat from step 2 until `done` is true.
6. Generate:

   ```
   matrix init <dir> --answers <dir>/.matrix/answers.json            # new project
   matrix init <dir> --answers <dir>/.matrix/answers.json --existing # existing repo, no scaffold
   ```

   Add `--yes` only if the user explicitly accepts all remaining recommendations.

## Handling results

- **Unanswered questions:** ask them, don't invent answers.
- **Contradictions:** explain each one in plain language and re-ask the listed questions.
- **Notes:** relay warnings (for example, a framework without a scaffold template yet).

## Style

- Be direct. One round per message, never one question per message.
- Business first: if the business answers are vague, push for specifics (who pays, why now, how they hear about it) before stack questions.
- Never pick answers for the user silently. Recommendations are proposals.
