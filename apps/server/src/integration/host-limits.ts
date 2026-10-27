import { cpus, freemem, totalmem } from "node:os";
import type { Limits } from "@matrix/core";
import { z } from "zod";

/**
 * Run concurrency for this host from its size: each agent run is one rootless container (about
 * 4 cores / 6 GB at peak), so light runs (spike, implement, checks, review) scale with CPU and RAM,
 * capped at 6. Heavy runs (QA builds, emulators, deploys) stay at one per host; the device and
 * simulator locks stay single-tenant on their own.
 */
export function autoLimits(
  host: string,
  sys: { cores: number; totalGb: number; freeGb: number } = {
    cores: cpus().length,
    totalGb: totalmem() / 2 ** 30,
    freeGb: freemem() / 2 ** 30,
  },
): Limits {
  // Free memory on Linux excludes page cache; half of total is a steadier budget.
  const ramGb = Math.max(sys.freeGb, sys.totalGb / 2);
  const light = Math.max(1, Math.min(6, Math.floor(sys.cores / 4), Math.floor(ramGb / 6)));
  return {
    perProject: Math.min(2, light),
    perModel: {},
    defaultPerModel: light,
    perHost: { [host]: light },
    defaultPerHost: light,
    heavyPerHost: {},
    defaultHeavyPerHost: 1,
  };
}

const limitsSchema = z
  .object({
    perProject: z.number().int().min(1).max(16),
    defaultPerModel: z.number().int().min(1).max(16),
    defaultPerHost: z.number().int().min(1).max(16),
    defaultHeavyPerHost: z.number().int().min(1).max(4),
    perModel: z.record(z.string(), z.number().int().min(1).max(16)),
    perHost: z.record(z.string(), z.number().int().min(1).max(16)),
    heavyPerHost: z.record(z.string(), z.number().int().min(1).max(4)),
  })
  .partial();

/** `MATRIX_LIMITS` JSON overrides on top of the host-sized defaults. */
export function parseLimitsEnv(raw: string | undefined): Partial<Limits> | undefined {
  if (!raw?.trim()) return undefined;
  return limitsSchema.parse(JSON.parse(raw)) as Partial<Limits>;
}
