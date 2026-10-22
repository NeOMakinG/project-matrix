import type { RunnerId } from "./ports.js";

/**
 * Subscription quota guard. Runs go through CLIProxyAPI on flat subscriptions (Claude, Codex):
 * dollars are not the binding constraint, the provider's usage windows are. Limits are per
 * provider; a run that hits a rate/usage limit puts its provider into an exponential cooldown.
 */
export interface ProviderQuota {
  /** Runs in flight at once on this provider (this reconciler). */
  maxConcurrent: number;
  /** Runs started in the last rolling hour. */
  maxRunsPerHour: number;
  /** Runner wall-clock minutes consumed in the last rolling 5 hours (Claude-style usage window). */
  maxRunnerMinutesPer5h: number;
}

export interface QuotaPolicy {
  defaults: ProviderQuota;
  providers: Record<string, Partial<ProviderQuota>>;
  cooldown: { baseMs: number; maxMs: number };
  /** Runner minutes one ticket may consume before it needs a human (when no spend data exists). */
  perTicketRunnerMinutes: number;
}

/** Conservative defaults: two runs at a time per subscription, well inside typical windows. */
export const DEFAULT_QUOTA: QuotaPolicy = {
  defaults: { maxConcurrent: 2, maxRunsPerHour: 20, maxRunnerMinutesPer5h: 300 },
  providers: {},
  cooldown: { baseMs: 60_000, maxMs: 60 * 60_000 },
  perTicketRunnerMinutes: 240,
};

export function quotaFor(policy: QuotaPolicy, provider: string): ProviderQuota {
  return { ...policy.defaults, ...policy.providers[provider] };
}

/** The subscription a run draws on: its runner, or the model family for multi-provider runners. */
export function providerOf(
  runner: RunnerId | string | undefined,
  model: string | undefined,
): string {
  if (runner === "claude-code") return "claude";
  if (runner === "codex") return "codex";
  const m = (model ?? "").toLowerCase();
  if (/claude|anthropic|opus|sonnet|haiku/.test(m)) return "claude";
  if (/gpt|codex|openai|^o\d/.test(m)) return "codex";
  return runner ?? "unknown";
}

/**
 * Rate-limit / usage-limit failures as reported by the gateway (HTTP 429) or the Claude Code /
 * Codex CLIs ("usage limit reached", "rate limit", "quota exceeded", "too many requests").
 */
const QUOTA_ERROR =
  /usage[ _-]limit[ _-](?:reached|exceeded)|hit your usage limit|rate_limit_error|rate[ _-]limit (?:reached|exceeded) for|insufficient_quota|quota[ _-](?:exceeded|exhausted)|API Error: 429|(?:HTTP|status(?: code)?:?) 429\b|429 Too Many Requests|last status: 429/i;

export function isQuotaError(text: string): boolean {
  return QUOTA_ERROR.test(text);
}

/**
 * The model gateway (CLIProxyAPI) did not answer the model-list check before a run started: an
 * infrastructure condition, not a ticket failure. Matches the runtime's exact wording only.
 */
const GATEWAY_UNAVAILABLE = /cannot verify model [^\n:]{1,200}: gateway unavailable/;

export function isGatewayUnavailable(text: string): boolean {
  return GATEWAY_UNAVAILABLE.test(text);
}

export interface ProviderCooldown {
  provider: string;
  until: Date;
  /** Consecutive quota failures; the next cooldown doubles until `cooldown.maxMs`. */
  failures: number;
  reason: string;
  at: Date;
}

/** In-memory cooldown book (a restart forgets it; the rolling limits still apply). */
export class QuotaCooldowns {
  readonly #byProvider = new Map<string, ProviderCooldown>();

  constructor(private readonly policy: QuotaPolicy) {}

  hit(provider: string, reason: string, now: Date): ProviderCooldown {
    const failures = (this.#byProvider.get(provider)?.failures ?? 0) + 1;
    const { baseMs, maxMs } = this.policy.cooldown;
    const ms = Math.min(maxMs, baseMs * 2 ** Math.min(failures - 1, 30));
    const state = { provider, until: new Date(now.getTime() + ms), failures, reason, at: now };
    this.#byProvider.set(provider, state);
    return state;
  }

  /** A successful run on the provider resets its backoff. */
  clear(provider: string): void {
    this.#byProvider.delete(provider);
  }

  active(provider: string, now: Date): ProviderCooldown | undefined {
    const state = this.#byProvider.get(provider);
    return state && state.until > now ? state : undefined;
  }

  list(): ProviderCooldown[] {
    return [...this.#byProvider.values()];
  }
}
