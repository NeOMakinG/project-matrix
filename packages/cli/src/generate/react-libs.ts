import type { MatrixConfig } from "@matrix/config";

export type ReactStack = Extract<NonNullable<MatrixConfig["frontend"]>, { framework: "react" }>;

/** Runtime libraries implied by the React answers, shared by every React scaffold. */
export function reactLibraryDeps(c: MatrixConfig, fe: ReactStack): string[] {
  const deps = ["zod"];
  if (fe.data === "tanstack-query") deps.push("@tanstack/react-query");
  if (fe.forms === "tanstack-form") deps.push("@tanstack/react-form");
  if (fe.tables === "tanstack-table") deps.push("@tanstack/react-table");
  if (fe.api === "trpc") deps.push("@trpc/client", "@trpc/tanstack-react-query");
  if (fe.effects === "effect") deps.push("effect");
  if (fe.authzProofs === "gdp-ts") deps.push("@gdp-ts/core");
  if (fe.motion === "motion") deps.push("motion");
  if (c.observability.analytics === "posthog") deps.push("posthog-js");
  if (c.observability.errors === "sentry") deps.push("@sentry/react");
  return deps;
}
