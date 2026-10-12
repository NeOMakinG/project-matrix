import { PHASES } from "@matrix/core";
import { z } from "zod";

export const LESSON_SOURCES = [
  "review-finding",
  "loopback",
  "qa-failure",
  "human-comment",
] as const;
export type LessonSource = (typeof LESSON_SOURCES)[number];

export const PhaseSchema = z.enum(PHASES);

export const RawLessonSchema = z.object({
  projectId: z.string(),
  ticketId: z.string(),
  source: z.enum(LESSON_SOURCES),
  phase: PhaseSchema,
  text: z.string().min(1),
  severity: z.enum(["P1", "P2", "P3"]).optional(),
  file: z.string().optional(),
  runId: z.string().optional(),
});
export type RawLesson = z.infer<typeof RawLessonSchema>;

export const CANDIDATE_KINDS = ["adr-rule", "prompt-patch", "checklist-item"] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

/** Candidate ids are `<kind>-<12 hex>`: safe as file names, never contain separators. */
export const CANDIDATE_ID = /^(adr-rule|prompt-patch|checklist-item)-[0-9a-f]{12}$/;
export const CandidateIdSchema = z.string().regex(CANDIDATE_ID);

export const CANDIDATE_STATUSES = ["proposed", "promoted", "rejected", "shadow"] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export const AdrRuleSchema = z.object({
  adr: z
    .string()
    .regex(/^ADR-\d{4}$/)
    .optional(),
  type: z.enum(["forbidden-import", "ast-grep", "required-header", "boundary"]),
  pattern: z.string().min(1).max(500),
  paths: z.array(z.string().max(200)).default([]),
  message: z.string().min(1).max(500),
});
export type AdrRule = z.infer<typeof AdrRuleSchema>;

export const CandidatePayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("adr-rule"), rule: AdrRuleSchema }),
  z.object({
    kind: z.literal("prompt-patch"),
    phase: PhaseSchema,
    text: z.string().min(1).max(2000),
  }),
  z.object({
    kind: z.literal("checklist-item"),
    phase: PhaseSchema,
    item: z.string().min(1).max(500),
  }),
]);
export type CandidatePayload = z.infer<typeof CandidatePayloadSchema>;

export const MetricsSchema = z.object({
  loopbacks: z.number().nonnegative(),
  p1Caught: z.number().nonnegative(),
  p1Expected: z.number().nonnegative(),
  /** P1 findings that matched no expected finding (penalises "flag everything"). */
  p1FalsePositives: z.number().nonnegative(),
  holdoutSatisfaction: z.number().min(0).max(1),
  costUsd: z.number().nonnegative(),
});
export type Metrics = z.infer<typeof MetricsSchema>;

export const EvaluationSchema = z.object({
  id: z.string().regex(/^eval-[0-9a-f]{16}$/),
  at: z.string(),
  candidateId: CandidateIdSchema,
  /** sha256 of the exact candidate patch (project, id, payload). */
  candidateHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** sha256 of the replay case set (ids, inputs, expectations). */
  caseSetHash: z.string().regex(/^[0-9a-f]{64}$/),
  harnessVersion: z.string(),
  executorId: z.string(),
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
      phase: PhaseSchema,
      baseline: MetricsSchema,
      candidate: MetricsSchema,
      baselineScore: z.number(),
      candidateScore: z.number(),
      delta: z.number(),
    }),
  ),
});
export type Evaluation = z.infer<typeof EvaluationSchema>;

/**
 * The candidate file in the repo. It is a proposal and a readable mirror only: whether a candidate is
 * promoted, approved and applicable is decided by the host-owned ledger, never by this file.
 */
export const CandidateSchema = z.object({
  id: CandidateIdSchema,
  projectId: z.string(),
  version: z.number().int().positive(),
  status: z.enum(CANDIDATE_STATUSES),
  title: z.string(),
  payload: CandidatePayloadSchema,
  evidence: z.array(RawLessonSchema),
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
