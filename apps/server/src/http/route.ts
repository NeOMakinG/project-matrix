import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Principal } from "../auth/guard.js";
import { ErrorBody } from "./schemas.js";

export type AppEnv = { Variables: { principal: Principal } };
export type App = OpenAPIHono<AppEnv>;

type Method = "get" | "post" | "patch" | "put" | "delete";

const errors = Object.fromEntries(
  ([400, 401, 403, 404, 409, 429] as const).map((status) => [
    status,
    { description: "Error", content: { "application/json": { schema: ErrorBody } } },
  ]),
);

/** Small wrapper so every route declares params, body and response once and gets the shared error shapes. */
export function route<
  P extends z.ZodObject | undefined,
  Q extends z.ZodObject | undefined,
  B extends z.ZodType | undefined,
  R extends z.ZodType,
>(def: {
  method: Method;
  path: string;
  tag: string;
  summary: string;
  params?: P;
  query?: Q;
  body?: B;
  response: R;
}) {
  return createRoute({
    method: def.method,
    path: def.path,
    tags: [def.tag],
    summary: def.summary,
    security: [{ bearer: [] }],
    request: {
      ...(def.params ? { params: def.params } : {}),
      ...(def.query ? { query: def.query } : {}),
      ...(def.body
        ? { body: { content: { "application/json": { schema: def.body } }, required: true } }
        : {}),
    } as {
      params: P extends z.ZodObject ? P : never;
      query: Q extends z.ZodObject ? Q : never;
      body: B extends z.ZodType
        ? { content: { "application/json": { schema: B } }; required: true }
        : never;
    },
    responses: {
      200: {
        description: "OK",
        content: { "application/json": { schema: def.response } },
      },
      ...errors,
    } as { 200: { description: string; content: { "application/json": { schema: R } } } },
  });
}

export const IdParam = z.object({ id: z.string().min(1) });
export const ProjectParam = z.object({ projectId: z.string().min(1) });
