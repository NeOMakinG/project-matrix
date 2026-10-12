import type { MatrixConfig } from "@matrix/config";
import type { Files } from "./docs";
import { jsxText, tsString } from "./escape";
import { headersLiteral } from "./headers";
import { type ReactStack, reactLibraryDeps } from "./react-libs";
import { pick } from "./versions";

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** Next.js App Router app in apps/web. */
export function nextFiles(c: MatrixConfig, fe: ReactStack, pkg: string): Files {
  const tailwind = fe.styling === "tailwind";
  const query = fe.data === "tanstack-query";
  const deps = ["next", "react", "react-dom", ...reactLibraryDeps(c, fe)];
  const dev = ["typescript", "@types/react", "@types/react-dom", "@types/node", "vitest"];
  if (tailwind) dev.push("tailwindcss", "@tailwindcss/postcss");
  if (fe.e2e === "playwright") dev.push("@playwright/test");

  const files: Files = {
    "apps/web/package.json": json({
      name: `${pkg}-web`,
      private: true,
      type: "module",
      scripts: {
        dev: "next dev",
        build: "next build",
        start: "next start",
        typecheck: "tsc -p tsconfig.json --noEmit",
        test: "vitest run --passWithNoTests",
      },
      dependencies: pick(deps),
      devDependencies: pick(dev),
    }),
    "apps/web/tsconfig.json": json({
      extends: "../../tsconfig.base.json",
      compilerOptions: {
        jsx: "preserve",
        lib: ["ES2023", "DOM", "DOM.Iterable"],
        allowJs: false,
        incremental: true,
        plugins: [{ name: "next" }],
      },
      include: ["next-env.d.ts", "app", "next.config.ts", ".next/types/**/*.ts"],
      exclude: ["node_modules"],
    }),
    "apps/web/next-env.d.ts":
      '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n',
    "apps/web/next.config.ts": `import type { NextConfig } from "next";

const securityHeaders = ${headersLiteral("")};

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: Object.entries(securityHeaders).map(([key, value]) => ({ key, value })),
      },
    ];
  },
};

export default config;
`,
    "apps/web/app/layout.tsx": `import type { Metadata } from "next";
import type { ReactNode } from "react";
${tailwind ? 'import "./globals.css";\n' : ""}${query ? 'import { Providers } from "./providers";\n' : ""}
export const metadata: Metadata = {
  title: ${tsString(c.business.name)},
  description: ${tsString(c.business.valueProposition)},
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>${query ? "\n        <Providers>{children}</Providers>\n      " : "{children}"}</body>
    </html>
  );
}
`,
    "apps/web/app/page.tsx": `export default function Home() {
  return (
    <main${tailwind ? ' className="mx-auto max-w-2xl p-8"' : ""}>
      <h1>${jsxText(c.business.name)}</h1>
      <p>${jsxText(c.business.valueProposition)}</p>
    </main>
  );
}
`,
  };
  if (query)
    files["apps/web/app/providers.tsx"] = `"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient());
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
`;
  if (tailwind) {
    files["apps/web/app/globals.css"] = '@import "tailwindcss";\n';
    files["apps/web/postcss.config.mjs"] =
      'export default { plugins: { "@tailwindcss/postcss": {} } };\n';
  }
  return files;
}
