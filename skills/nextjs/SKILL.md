---
name: nextjs
description: Quality rules for Next.js App Router apps in a Matrix project — server/client components, data fetching, server actions, caching and security. Use when writing or reviewing Next.js pages, layouts, route handlers or server actions.
---

# Next.js (App Router) quality

## Server vs client

- Components are Server Components by default. Add `"use client"` only at the leaf that needs state, effects or browser APIs.
- Never import server-only modules (DB, secrets) into a client component; mark them with `import "server-only"`.
- Pass serializable props from server to client components.

## Data

- Fetch in Server Components or route handlers, close to where data is used; parallelize independent fetches.
- Be explicit about caching: `export const dynamic`, `revalidate`, or `fetch(..., { cache })`. Never rely on defaults you haven't checked for the installed version.
- Client-side server state uses TanStack Query through a `Providers` client component.

## Mutations (server actions)

- Every server action parses input with Zod and checks authorization itself; actions are public endpoints.
- Revalidate the exact paths/tags affected (`revalidatePath`, `revalidateTag`).
- Return typed results; never throw raw errors to the client.

## Routing

- `loading.tsx` and `error.tsx` per segment that fetches; `not-found.tsx` for missing records.
- Metadata via `generateMetadata`; user content in metadata is escaped by Next, but never inject raw HTML.

## Security

- Set security headers (CSP, frame-ancestors) in `next.config.ts` or middleware.
- Middleware is not an auth boundary on its own; re-check in the page/action.
