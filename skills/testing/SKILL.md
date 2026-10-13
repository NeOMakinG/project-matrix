---
name: testing
description: Testing strategy for Matrix projects — unit, integration and end-to-end tests, QA receipts and what makes a test trustworthy. Use when adding tests, fixing flaky tests, or producing QA evidence for a ticket.
---

# Testing

## What to test

- Business rules: unit tests on pure functions, table-driven, edge cases first (empty, max, timezone, currency).
- Boundaries: integration tests hitting a real database (container) and real HTTP handlers. Don't mock what you own.
- Journeys: one end-to-end test per critical user flow (Playwright for web, Maestro for mobile).

## Trustworthy tests

- A test must fail when the behaviour breaks. Before trusting a new test, break the code and watch it fail.
- No sleeps; wait for conditions. No order dependence; each test sets up its own data.
- Never weaken an assertion or delete a test to make CI green. Fix the code or file a ticket.
- Never write tests aimed at hidden holdout scenarios; test the acceptance criteria you were given.

## QA receipts

- Screenshots and videos come from the real app, at the commit under review.
- API receipts show method, URL, status and a redacted body.
- Every receipt says what it proves ("annual plan checkout succeeds with test card").
