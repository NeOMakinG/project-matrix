import type { Ticket } from "@matrix/tickets";
import type { Phase } from "./ports.js";
import type { PhaseModel, ProjectConfig } from "./types.js";

export function resolveModel(config: ProjectConfig, model: string): string {
  return config.models.aliases?.[model] ?? model;
}

export function selectModel(
  config: ProjectConfig,
  phase: Phase,
  ticket?: Pick<Ticket, "labels" | "estimate">,
): PhaseModel {
  if ((phase === "spike" || phase === "implement") && config.models.tiers) {
    const small =
      ticket?.labels.includes("size:small") ||
      (ticket?.estimate !== undefined &&
        Number.isFinite(ticket.estimate) &&
        ticket.estimate >= 0 &&
        ticket.estimate < (config.models.smallEstimateThreshold ?? 3));
    return config.models.tiers[small ? "small" : "large"];
  }
  return config.models[phase] ?? config.models.implement;
}
