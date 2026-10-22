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

/** Model ids a plan names (before aliases). */
export function planModelIds(plan: ModelPlan): string[] {
  return [
    ...PLAN_PHASES.map((phase) => plan[phase]?.model),
    ...(plan.reviewerFallbacks ?? []).map((m) => m.model),
  ].filter((m): m is string => Boolean(m));
}

/** Every model id a project config would call on the gateway (aliases resolved). */
export function configModelIds(config: ProjectConfig): string[] {
  const m = config.models;
  const phases = Object.entries(m)
    .filter(([key]) => key !== "aliases" && key !== "tiers" && key !== "smallEstimateThreshold")
    .map(([, value]) => (value as PhaseModel | undefined)?.model);
  return [
    ...phases,
    m.tiers?.large.model,
    m.tiers?.small.model,
    ...(config.reviewerFallbacks ?? []).map((f) => f.model),
  ]
    .filter((id): id is string => Boolean(id))
    .map((id) => resolveModel(config, id));
}

/**
 * Rejects model ids the gateway does not serve (`GET /v1/models`). With a gateway configured, an
 * unreachable or malformed model list is an error too: an unverified id fails later as a blocked
 * ticket, which is far more expensive than a clear 400 at registration.
 */
export async function assertKnownModels(ids: string[], list?: ModelLister): Promise<void> {
  if (!list) return;
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return;
  const known = await list().catch(() => undefined);
  if (!known)
    throw new CoreError(
      "invalid_request",
      `cannot verify model ids (${wanted.join(", ")}): the gateway model list (GET /v1/models) did not answer`,
    );
  const available = new Set(known);
  const missing = wanted.filter((m) => !available.has(m));
  if (missing.length)
    throw new CoreError(
      "invalid_request",
      `model(s) not served by the gateway: ${missing.join(", ")}. Pick ids from GET /v1/models or set models.aliases.`,
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
