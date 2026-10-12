/**
 * Contracts for endpoints the dashboard needs but the server (PR #2) does not
 * expose yet. They are validated at runtime and listed in the PR so the server
 * can implement them with these exact shapes.
 */
import { z } from "zod";

export const toneSchema = z.enum(["green", "blue", "amber", "red", "violet", "neutral"]);
export type Tone = z.infer<typeof toneSchema>;
const pill = z.object({ label: z.string(), tone: toneSchema });
export type PillData = z.infer<typeof pill>;

/** GET /v1/projects/{projectId}/verification — latest post-deploy check (not in the server yet). */
export const verificationSchema = z.object({
  deploy: z.string(),
  ago: z.string(),
  series: z.array(z.number()),
  deployIndex: z.number(),
  rows: z.array(z.object({ label: z.string(), value: pill })),
});
export type Verification = z.infer<typeof verificationSchema>;

/** POST /auth/login and GET /auth/session (server PR #2): cookie session + CSRF token. */
export const sessionSchema = z.object({
  csrfToken: z.string().min(1),
  expiresAt: z.string(),
  key: z
    .object({ id: z.string(), name: z.string(), kind: z.enum(["human", "agent"]) })
    .passthrough()
    .nullable(),
});
export type Session = z.infer<typeof sessionSchema>;

/** Settings keys the dashboard reads inside the free-form `Settings` object. */
export const dashboardSettingsSchema = z.object({
  runners: z
    .array(z.object({ phase: z.string(), runner: z.string(), model: z.string() }))
    .default([]),
  runnerOptions: z.array(z.string()).default([]),
  modelOptions: z.array(z.string()).default([]),
});
export type DashboardSettings = z.infer<typeof dashboardSettingsSchema>;
