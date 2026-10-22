import { type PhaseModel, type ProjectConfig, resolveModel } from "@matrix/core";
import { CoreError } from "../core-port.js";

/** Phases whose model the operator picks (the others run no model). */
export const PLAN_PHASES = ["spike", "design", "implement", "review", "qa"] as const;
export type PlanPhase = (typeof PLAN_PHASES)[number];

export type ModelPlan = Partial<Record<PlanPhase, PhaseModel>> & {
  /** Tried in order when the review model equals the implementer's. */
  reviewerFallbacks?: PhaseModel[];
};

/** Lists the model ids the gateway serves; undefined when it cannot be reached. */
export type ModelLister = () => Promise<string[] | undefined>;

/**
 * Applies a per-phase model plan to a project config (in place). Choosing `implement` or `spike`
 * explicitly drops the size tiers, which would otherwise override both phases.
 */
export function applyModelPlan(config: ProjectConfig, plan: ModelPlan): void {
  const models = { ...config.models };
  for (const phase of PLAN_PHASES) {
    const choice = plan[phase];
    if (choice) models[phase] = { runner: choice.runner, model: choice.model };
  }
  if (plan.implement || plan.spike) delete models.tiers;
  config.models = models;
  if (plan.reviewerFallbacks)
    config.reviewerFallbacks = plan.reviewerFallbacks.map((m) => ({ ...m }));
  assertIndependentReview(config);
}

/** The review model must never be the implementer's (nor either size tier's). */
export function assertIndependentReview(config: ProjectConfig): void {
  const implementers = new Set(
    [
      config.models.implement.model,
      config.models.tiers?.large.model,
      config.models.tiers?.small.model,
    ]
      .filter((m): m is string => Boolean(m))
      .map((m) => resolveModel(config, m)),
  );
  if (implementers.has(resolveModel(config, config.models.review.model)))
    throw new CoreError(
      "invalid_request",
      "the review model must differ from the implement model (independent review)",
    );
}

/** Rejects model ids the gateway does not serve; skipped when the gateway is unreachable. */
export async function assertKnownModels(plan: ModelPlan, list?: ModelLister): Promise<void> {
  if (!list) return;
  const wanted = [
    ...PLAN_PHASES.map((phase) => plan[phase]?.model),
    ...(plan.reviewerFallbacks ?? []).map((m) => m.model),
  ].filter((m): m is string => Boolean(m));
  if (wanted.length === 0) return;
  const known = await list().catch(() => undefined);
  if (!known) return;
  const available = new Set(known);
  const missing = [...new Set(wanted)].filter((m) => !available.has(m));
  if (missing.length)
    throw new CoreError(
      "invalid_request",
      `unknown model(s) on the gateway: ${missing.join(", ")}`,
    );
}

/** `GET <baseUrl>/models` on the OpenAI-compatible gateway (baseUrl ends in `/v1`). */
export function gatewayModels(
  baseUrl: string,
  apiKey: string,
  fetcher?: typeof fetch,
  timeoutMs = 3_000,
): ModelLister {
  return async () => {
    try {
      const response = await (fetcher ?? globalThis.fetch)(`${baseUrl.replace(/\/$/, "")}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as { data?: unknown };
      if (!Array.isArray(body.data)) return undefined;
      return body.data
        .map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : undefined))
        .filter((id): id is string => typeof id === "string");
    } catch {
      return undefined;
    }
  };
}
