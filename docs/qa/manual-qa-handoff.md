# Manual QA handoff (no device driver on the host)

Matrix's automatic QA drives host probes, HTTP APIs and browsers. Android/iOS UI flows cannot be
verified inside a run on the Matrix host. Instead of blocking with nothing to show, a project can
opt into a handoff of the draft PR:

- `qa.driver: "agent"` (recommended for Android): the **agent QA lane** builds the draft PR on the
  device host, a QA agent tests it on a real device and its verdict drives the ticket (PASS keeps
  it at Awaiting merge for a human merge, FAIL loops back to Implement, BLOCKED asks a human).
  See [agent-qa-lane.md](agent-qa-lane.md).
- `qa.driver: "manual"`: a human tests it (this page).

## Configure (trusted project config only)

```sh
curl -X PATCH "$MATRIX/v1/projects/<id>" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"qa":{"surfaces":["android"],"driver":"manual"}}'
```

- `qa.surfaces`: what QA must exercise (`host`, `api`, `web`, `android`, `ios`).
- `qa.driver`: `agent` hands off to the agent QA lane; `manual` hands off to a human; `none`
  (default) blocks QA with
  `no android QA driver on this host; set the project's qa.driver to "manual" ...`.
- `"qa": null` removes the settings.

## Surface detection

Required device surfaces = the project's `qa.surfaces` (android/ios), narrowed by the ticket's
optional `QA: Surface: android` line. Ticket text is untrusted: it can only **narrow** among the
configured surfaces, never add one, and a line naming none of them is ignored (a `QA: Surface:
web` ticket on an android-only project still needs android QA; on a project configured with
`["android","web"]` it runs automatic web QA). A ticket claiming `android` on a project without `qa` config runs normal QA. When
the QA driver reports a driver for every required surface (`QaDriver.surfaces`), QA runs
automatically; the handoff only happens when a surface has no driver. The spike phase logs the
decision when it stores the holdout scenarios.

## What happens

1. Checks and review run and must pass as usual.
2. The QA phase records a core-produced handoff receipt (`matrix:manual-qa:v1`: surfaces, the
   ticket's public acceptance criteria, the number of private scenarios). Holdout scenarios stay
   hidden: no holdout text is quoted anywhere. A QA driver cannot supply this receipt (discarded).
   The holdout judge does not run (its scenarios are UI flows no host probe can demonstrate).
   Projects whose ticket requires an approved Figma design block here instead (a handoff has no
   device screenshots to compare).
3. Merge then **always** waits for a human approval, whatever the merge autonomy (also enforced in
   `authorize`). The merge gate re-checks that the project still has `qa.driver: "manual"` for
   those surfaces.
4. Matrix pushes the run branch and opens the **draft** PR: summary, evidence links,
   checks/review results and a `## Manual QA needed` checklist rendered from the ticket's
   `Acceptance criteria` list items (untrusted text, escaped).
5. The ticket moves to Awaiting merge (Linear), gets the `needs-human` label and a comment
   `manual Android QA required — draft PR ready: <PR url>`; the live status comment shows the PR
   with the same reason.

## After the human tested

- **Accept:** merge the draft PR on GitHub, then approve the merge in Matrix: it finishes normally
  (a PR merged with commits Matrix never validated still needs a human).
- **Request changes:** comment on the ticket and move it back to Ready (only a move back counts:
  Matrix must first have seen the ticket outside Ready, e.g. in Awaiting merge, since the handoff;
  this memory is per process, so after a server restart move it out and back again). Matrix withdraws the
  pending merge approval, removes `needs-human` and loops back to implement (a review loop, counted
  against `maxLoops`); the comments reach the implementer prompt.
