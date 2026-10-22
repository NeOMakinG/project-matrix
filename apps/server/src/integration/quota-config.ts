import { type QuotaConfig, quotaConfig } from "@matrix/config";
import { DEFAULT_QUOTA, type QuotaPolicy } from "@matrix/core";

/** Drops keys whose value is undefined (zod partials) so spreads keep the defaults. */
function defined<T extends object>(
  value: T | undefined,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

/** Merges a validated `MATRIX_QUOTA` config over the conservative defaults. */
export function resolveQuota(input: QuotaConfig = {}): {
  quota: QuotaPolicy;
  maxRequeuesPerDay?: number;
} {
  const config = quotaConfig.parse(input);
  const providers: QuotaPolicy["providers"] = {};
  for (const [name, limits] of Object.entries(config.providers ?? {}))
    providers[name] = defined(limits);
  const quota: QuotaPolicy = {
    defaults: { ...DEFAULT_QUOTA.defaults, ...defined(config.defaults) },
    providers,
    cooldown: { ...DEFAULT_QUOTA.cooldown, ...defined(config.cooldown) },
    perTicketRunnerMinutes: config.perTicketRunnerMinutes ?? DEFAULT_QUOTA.perTicketRunnerMinutes,
  };
  if (quota.cooldown.maxMs < quota.cooldown.baseMs)
    throw new Error("MATRIX_QUOTA cooldown.maxMs must be >= cooldown.baseMs");
  return {
    quota,
    ...(config.maxRequeuesPerDay !== undefined
      ? { maxRequeuesPerDay: config.maxRequeuesPerDay }
      : {}),
  };
}

/** Parses the `MATRIX_QUOTA` env value (JSON); empty means defaults. */
export function parseQuotaEnv(raw: string | undefined): QuotaConfig {
  if (!raw?.trim()) return {};
  try {
    return quotaConfig.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`invalid MATRIX_QUOTA: ${(error as Error).message}`);
  }
}
