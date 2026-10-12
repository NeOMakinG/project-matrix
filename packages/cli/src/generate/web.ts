import type { MatrixConfig } from "@matrix/config";
import type { Files } from "./docs";
import { pick } from "./versions";

type React = Extract<NonNullable<MatrixConfig["frontend"]>, { framework: "react" }>;

export function webFiles(c: MatrixConfig, fe: React, pkgName: string): Files {
  const deps = ["react", "react-dom", "zod"];
  const dev = [
    "vite",
    "@vitejs/plugin-react",
    "typescript",
    "@types/react",
    "@types/react-dom",
    "vitest",
  ];
  if (fe.data === "tanstack-query") deps.push("@tanstack/react-query");
  if (fe.router === "tanstack-router") deps.push("@tanstack/react-router");
  if (fe.forms === "tanstack-form") deps.push("@tanstack/react-form");
  if (fe.tables === "tanstack-table") deps.push("@tanstack/react-table");
  if (fe.api === "trpc") deps.push("@trpc/client", "@trpc/tanstack-react-query");
  if (fe.effects === "effect") deps.push("effect");
  if (fe.motion === "motion") deps.push("motion");
  if (fe.styling === "tailwind") dev.push("tailwindcss", "@tailwindcss/vite");
  if (fe.e2e === "playwright") dev.push("@playwright/test");
  if (c.observability.analytics === "posthog") deps.push("posthog-js");
  if (c.observability.errors === "sentry") deps.push("@sentry/react");

  const tailwind = fe.styling === "tailwind";
  const query = fe.data === "tanstack-query";
  const router = fe.router === "tanstack-router";

  const imports = [
    'import { StrictMode } from "react";',
    'import { createRoot } from "react-dom/client";',
    query ? 'import { QueryClient, QueryClientProvider } from "@tanstack/react-query";' : "",
    router
      ? 'import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";'
      : "",
    tailwind ? 'import "./styles.css";' : "",
  ].filter(Boolean);

  const home = `function Home() {
  return (
    <main${tailwind ? ' className="mx-auto max-w-2xl p-8"' : ""}>
      <h1>${c.business.name}</h1>
      <p>${c.business.valueProposition.replace(/[{}<>]/g, "")}</p>
    </main>
  );
}`;

  const routerSetup = router
    ? `
const rootRoute = createRootRoute();
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Home });
const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute]) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
`
    : "";

  const inner = router ? "<RouterProvider router={router} />" : "<Home />";
  const app = query
    ? `<QueryClientProvider client={queryClient}>${inner}</QueryClientProvider>`
    : inner;

  const main = `${imports.join("\n")}

${home}
${routerSetup}${query ? "\nconst queryClient = new QueryClient();\n" : ""}
const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    ${app}
  </StrictMode>,
);
`;

  return {
    "apps/web/package.json": `${JSON.stringify(
      {
        name: `${pkgName}-web`,
        private: true,
        type: "module",
        scripts: {
          dev: "vite",
          build: "vite build",
          typecheck: "tsc -p tsconfig.json",
          test: "vitest run --passWithNoTests",
        },
        dependencies: pick(deps),
        devDependencies: pick(dev),
      },
      null,
      2,
    )}\n`,
    "apps/web/tsconfig.json": `${JSON.stringify(
      {
        extends: "../../tsconfig.base.json",
        compilerOptions: {
          jsx: "react-jsx",
          lib: ["ES2023", "DOM", "DOM.Iterable"],
          types: ["vite/client"],
        },
        include: ["src", "vite.config.ts"],
      },
      null,
      2,
    )}\n`,
    "apps/web/vite.config.ts": `import react from "@vitejs/plugin-react";
${tailwind ? 'import tailwindcss from "@tailwindcss/vite";\n' : ""}import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()${tailwind ? ", tailwindcss()" : ""}],
});
`,
    "apps/web/index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${c.business.name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    "apps/web/src/main.tsx": main,
    ...(tailwind ? { "apps/web/src/styles.css": '@import "tailwindcss";\n' } : {}),
  };
}
