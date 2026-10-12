import { type Action, type ApiKeyRecord, allows, type KeyStore } from "./keys.js";
import type { AuditLog, BudgetKind, BudgetTracker, RateLimiter } from "./limits.js";

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429,
    readonly code: string,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

export interface Principal {
  key: ApiKeyRecord;
}

export interface GuardedOp {
  action: Action;
  projectId?: string;
  budget?: BudgetKind;
  mutating: boolean;
  method: string;
  path: string;
}

export class Guard {
  constructor(
    private readonly keys: KeyStore,
    private readonly limiter: RateLimiter,
    private readonly budgets: BudgetTracker,
    private readonly audit: AuditLog,
  ) {}

  /** Resolves a bearer token to a principal and applies the per-key rate limit. */
  authenticate(authorization: string | undefined | null): Principal {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const key = token ? this.keys.verify(token) : null;
    if (!key) throw new HttpError(401, "unauthorized", "missing or invalid API key");
    const rate = this.limiter.take(key.id, key.ratePerMinute);
    if (!rate.ok) {
      throw new HttpError(429, "rate_limited", "rate limit exceeded", rate.retryAfterSec);
    }
    return { key };
  }

  /** Checks scope and budget, runs the operation, and audits every mutating call (allowed or not). */
  async run<T>(principal: Principal, op: GuardedOp, fn: () => Promise<T>): Promise<T> {
    const audit = (status: number, detail?: string) =>
      op.mutating
        ? this.audit.record({
            at: new Date().toISOString(),
            keyId: principal.key.id,
            action: op.action,
            method: op.method,
            path: op.path,
            status,
            ...(op.projectId ? { projectId: op.projectId } : {}),
            ...(detail ? { detail } : {}),
          })
        : Promise.resolve();

    if (!allows(principal.key.scope, op.action, op.projectId)) {
      await audit(403, "scope");
      throw new HttpError(403, "forbidden", `key lacks ${op.action} on this project`);
    }
    if (op.mutating) {
      const kinds: BudgetKind[] = op.budget ? ["mutations", op.budget] : ["mutations"];
      for (const kind of kinds) {
        if (!this.budgets.consume(principal.key.id, principal.key.budget, kind)) {
          await audit(429, `budget:${kind}`);
          throw new HttpError(429, "budget_exceeded", `daily ${kind} budget exhausted`);
        }
      }
    }
    try {
      const result = await fn();
      await audit(200);
      return result;
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      await audit(status, error instanceof Error ? error.message : "error");
      throw error;
    }
  }
}
