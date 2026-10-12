---
name: react
description: Quality rules for React apps in a Matrix project — TanStack Router/Query/Form/Table, Zod, tRPC, Effect and gdp-ts. Use when writing or reviewing React components, routes, data fetching, forms or tables.
---

# React quality

Follow the project's ADRs first; this skill covers the defaults the factory recommends.

## Data (TanStack Query)

- Server state lives in Query, never in `useState` + `useEffect` fetches.
- Query keys are arrays from a key factory per feature: `invoiceKeys.detail(id)`. Never inline ad-hoc strings.
- Wrap queries in `queryOptions()` so loaders, prefetching and components share one definition.
- Mutations invalidate or update the exact keys they affect; optimistic updates roll back in `onError`.
- Don't copy query data into local state. Derive with `select`.

## Routing (TanStack Router)

- Validate search params with Zod (`validateSearch`); treat the URL as typed state.
- Load data in route `loader`s with `queryClient.ensureQueryData(...)`, render with `useSuspenseQuery`.
- Use `<Link to>` with typed params; a broken link must be a type error.

## Forms and tables

- TanStack Form with a Zod schema shared with the server (`@app/shared` or the tRPC input).
- Field errors render next to the field; submit is disabled while pending.
- TanStack Table: columns defined once with `createColumnHelper`, server-side pagination for large lists.

## Types and boundaries

- Zod parses every untrusted input: API responses from outside the typed contract, URL params, storage.
- tRPC: the web app imports only the router **type**, never server code (enforced by ADR rule).
- Effect: use for workflows with retries, timeouts and typed errors, not for simple UI logic.
- gdp-ts: authorization checks produce proofs; functions that need authorization take the proof type, so skipping a check fails to compile.

## Components

- Components are small and named after the domain (`InvoiceRow`, not `Row2`).
- No business logic in JSX; extract hooks or pure functions with tests.
- Avoid `useEffect` for derived state; compute during render or memoize when measured.
- Every interactive element is reachable by keyboard (see the accessibility skill).

Further reading: the TanStack Query and Vercel React best-practices skills (MIT) cover performance patterns in depth.
