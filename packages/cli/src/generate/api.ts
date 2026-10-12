import type { MatrixConfig } from "@matrix/config";
import type { Files } from "./docs";
import { pick } from "./versions";

export function apiFiles(c: MatrixConfig, pkgName: string): { files: Files; warnings: string[] } {
  const b = c.backend;
  if (b.kind !== "node-api") return { files: {}, warnings: [] };
  if (b.framework && b.framework !== "hono") {
    return {
      files: {},
      warnings: [
        `API scaffold only supports Hono today; ${b.framework} was chosen, so apps/api was not generated.`,
      ],
    };
  }
  const trpc = c.frontend?.framework === "react" && c.frontend.api === "trpc";
  const deps = ["hono", "zod"];
  const dev = ["typescript", "@types/bun"];
  if (trpc) deps.push("@trpc/server", "@hono/trpc-server");
  if (b.orm === "drizzle") {
    deps.push("drizzle-orm");
    dev.push("drizzle-kit");
    if (b.database === "postgres") deps.push("postgres");
    if (b.database === "sqlite") deps.push("@libsql/client");
  }
  if (b.auth === "better-auth") deps.push("better-auth");
  if (c.frontend?.framework === "react" && c.frontend.authzProofs === "gdp-ts")
    deps.push("@gdp-ts/core");
  if (b.payments === "stripe") deps.push("stripe");
  if (b.jobs === "bullmq") deps.push("bullmq");
  if (b.telemetry === "opentelemetry") deps.push("@opentelemetry/api");
  if (c.observability.errors === "sentry") deps.push("@sentry/node");

  const files: Files = {
    "apps/api/package.json": `${JSON.stringify(
      {
        name: `${pkgName}-api`,
        private: true,
        type: "module",
        scripts: {
          dev: "bun --watch src/index.ts",
          typecheck: "tsc -p tsconfig.json",
          test: "bun test --pass-with-no-tests",
        },
        dependencies: pick(deps),
        devDependencies: pick(dev),
      },
      null,
      2,
    )}\n`,
    "apps/api/tsconfig.json": `${JSON.stringify(
      {
        extends: "../../tsconfig.base.json",
        compilerOptions: { types: ["bun"] },
        include: ["src"],
      },
      null,
      2,
    )}\n`,
    "apps/api/src/index.ts": `import { Hono } from "hono";
${trpc ? 'import { trpcServer } from "@hono/trpc-server";\nimport { appRouter } from "./trpc";\n' : ""}
export const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));
${trpc ? '\napp.use("/trpc/*", trpcServer({ router: appRouter }));\n' : ""}
export default { port: Number(process.env.PORT ?? 3000), fetch: app.fetch };
`,
  };

  if (trpc) {
    files["apps/api/src/trpc.ts"] = `import { initTRPC } from "@trpc/server";
import { z } from "zod";

const t = initTRPC.create();

export const appRouter = t.router({
  health: t.procedure.query(() => ({ ok: true })),
  echo: t.procedure.input(z.object({ text: z.string() })).query(({ input }) => input),
});

export type AppRouter = typeof appRouter;
`;
  }

  if (b.orm === "drizzle" && b.database === "postgres") {
    files["apps/api/src/db/schema.ts"] =
      `import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
`;
  }
  if (b.orm === "drizzle" && b.database === "sqlite") {
    files["apps/api/src/db/schema.ts"] =
      `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
`;
  }
  return { files, warnings: [] };
}
