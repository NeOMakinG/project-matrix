import { z } from "zod";

export const LESSON_SOURCES = [
  "review-finding",
  "loopback",
  "qa-failure",
  "human-comment",
] as const;
export type LessonSource = (typeof LESSON_SOURCES)[number];

export const RawLessonSchema = z.object({
  projectId: z.string(),
  ticketId: z.string(),
  source: z.enum(LESSON_SOURCES),
  phase: z.string(),
  text: z.string().min(1),
  severity: z.enum(["P1", "P2", "P3"]).optional(),
  file: z.string().optional(),
  runId: z.string().optional(),
});
export type RawLesson = z.infer<typeof RawLessonSchema>;

export const CANDIDATE_KINDS = ["adr-rule", "prompt-patch", "checklist-item"] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

export const CANDIDATE_STATUSES = ["proposed", "promoted", "rejected", "shadow"] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export const AdrRuleSchema = z.object({
  adr: z.string().optional(),
  type: z.enum(["forbidden-import", "ast-grep", "required-header", "boundary"]),
  pattern: z.string().min(1),
  paths: z.array(z.string()).default([]),
  message: z.string().min(1),
});
export type AdrRule = z.infer<typeof AdrRuleSchema>;

export const CandidatePayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("adr-rule"), rule: AdrRuleSchema }),
  z.object({
    kind: z.literal("prompt-patch"),
    phase: z.string(),
    text: z.string().min(1),
  }),
  z.object({
    kind: z.literal("checklist-item"),
    phase: z.string(),
    item: z.string().min(1),
  }),
]);
export type CandidatePayload = z.infer<typeof CandidatePayloadSchema>;

export const MetricsSchema = z.object({
  loopbacks: z.number().nonnegative(),
  p1Caught: z.number().nonnegative(),
  p1Expected: z.number().nonnegative(),
  holdoutSatisfaction: z.number().min(0).max(1),
  costUsd: z.number().nonnegative(),
});
export type Metrics = z.infer<typeof MetricsSchema>;

export const EvaluationSchema = z.object({
  id: z.string(),
  at: z.string(),
  candidateVersion: z.number().int().positive(),
  samples: z.number().int().nonnegative(),
  baseline: MetricsSchema,
  candidate: MetricsSchema,
  baselineScore: z.number(),
  candidateScore: z.number(),
  delta: z.number(),
  decision: z.enum(["promote", "reject", "shadow"]),
  reason: z.string(),
  cases: z.array(
    z.object({
      caseId: z.string(),
      baseline: MetricsSchema,
      candidate: MetricsSchema,
    }),
  ),
});
export type Evaluation = z.infer<typeof EvaluationSchema>;

export const CandidateSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  version: z.number().int().positive(),
  status: z.enum(CANDIDATE_STATUSES),
  title: z.string(),
  payload: CandidatePayloadSchema,
  evidence: z.array(RawLessonSchema),
  evaluations: z.array(EvaluationSchema),
  history: z.array(
    z.object({
      at: z.string(),
      version: z.number(),
      status: z.enum(CANDIDATE_STATUSES),
      note: z.string(),
    }),
  ),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Candidate = z.infer<typeof CandidateSchema>;
