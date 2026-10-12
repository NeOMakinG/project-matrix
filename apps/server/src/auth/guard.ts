import { type Action, type ApiKeyRecord, allows, type KeyStore, type OpScope } from "./keys.js";
import type { AuditLog, BudgetKind, BudgetTracker, Clock, RateLimiter } from "./limits.js";

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 412 | 422 | 428 | 429,
    readonly code: string,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

export interface Principal {
  key: ApiKeyRecord;
  /** Optional `Idempotency-Key` of the request: replays return the first result without re-running. */
  idempotencyKey?: string;
}

export interface GuardedOp {
  action: Action;
  target: OpScope;
  budget?: BudgetKind;
  mutating: boolean;
  method: string;
  path: string;
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

type StoredResult = {
  at: number;
  fingerprint: string;
  outcome: { ok: true; value: unknown } | { ok: false; error: unknown };
};

export class Guard {
  private readonly idempotent = new Map<string, StoredResult>();

  constructor(
    private readonly keys: KeyStore,
    private readonly limiter: RateLimiter,
    private readonly budgets: BudgetTracker,
    private readonly audit: AuditLog,
    private readonly clock: Clock = Date.now,
  ) {}

  /** Resolves a bearer token to a principal and applies the per-key rate limit. */
  authenticate(
    authorization: string | undefined | null,
    idempotencyKey?: string | null,
  ): Principal {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const key = token ? this.keys.verify(token) : null;
    if (!key) throw new HttpError(401, "unauthorized", "missing or invalid API key");
    return this.principalFor(key, idempotencyKey);
  }

  /** Builds a principal for an already-verified key (bearer or dashboard session). */
  principalFor(key: ApiKeyRecord, idempotencyKey?: string | null): Principal {
    if (key.revokedAt) throw new HttpError(401, "unauthorized", "API key revoked");
    const rate = this.limiter.take(key.id, key.ratePerMinute);
    if (!rate.ok) {
      throw new HttpError(429, "rate_limited", "rate limit exceeded", rate.retryAfterSec);
    }
    if (idempotencyKey !== undefined && idempotencyKey !== null) {
      if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(idempotencyKey)) {
        throw new HttpError(
          400,
          "invalid_request",
          "Idempotency-Key must be 8-128 safe characters",
        );
      }
      return { key, idempotencyKey };
    }
    return { key };
  }

  /**
   * Checks scope and budget, writes the audit intent BEFORE executing (fail closed if the audit log
   * can't be written), runs the operation, then audits the outcome. Mutations with an idempotency key
   * run once; replays get the stored result.
   */
  async run<T>(principal: Principal, op: GuardedOp, fn: () => Promise<T>): Promise<T> {
    const projectId = op.target.kind === "project" ? op.target.projectId : undefined;
    const entry = (status: number, detail?: string) => ({
      at: new Date(this.clock()).toISOString(),
      keyId: principal.key.id,
      action: op.action,
      method: op.method,
      path: op.path,
      status,
      ...(projectId ? { projectId } : {}),
      ...(detail ? { detail } : {}),
    });
    const audit = async (status: number, detail?: string) => {
      if (op.mutating) await this.audit.record(entry(status, detail));
    };

    if (!allows(principal.key.scope, op.action, op.target)) {
      await audit(403, "scope");
      const where =
        op.target.kind === "global" ? "factory-wide (needs all projects)" : "on this project";
      throw new HttpError(403, "forbidden", `key lacks ${op.action} ${where}`);
    }

    const slot =
      op.mutating && principal.idempotencyKey
        ? `${principal.key.id}:${principal.idempotencyKey}`
        : undefined;
    if (slot) {
      this.expireIdempotency();
      const stored = this.idempotent.get(slot);
      const fingerprint = `${op.method} ${op.path}`;
      if (stored) {
        if (stored.fingerprint !== fingerprint) {
          throw new HttpError(
            422,
            "idempotency_mismatch",
            "Idempotency-Key was used for a different request",
          );
        }
        await audit(200, "idempotent-replay");
        if (stored.outcome.ok) return stored.outcome.value as T;
        throw stored.outcome.error;
      }
    }

    if (op.mutating) {
      const kinds: BudgetKind[] = op.budget ? ["mutations", op.budget] : ["mutations"];
      for (const kind of kinds) {
        if (!this.budgets.consume(principal.key.id, principal.key.budget, kind)) {
          await audit(429, `budget:${kind}`);
          throw new HttpError(429, "budget_exceeded", `daily ${kind} budget exhausted`);
        }
      }
      // Intent first: if this write fails the operation never runs.
      await audit(0, "started");
    }

    let outcome: StoredResult["outcome"];
    try {
      outcome = { ok: true, value: await fn() };
    } catch (error) {
      outcome = { ok: false, error };
    }
    // Store before auditing the outcome: if the audit write fails the client gets an error, and a
    // retry with the same Idempotency-Key returns this result instead of running the operation twice.
    if (slot)
      this.idempotent.set(slot, {
        at: this.clock(),
        fingerprint: `${op.method} ${op.path}`,
        outcome,
      });
    if (outcome.ok) {
      await audit(200);
      return outcome.value as T;
    }
    const failure = outcome.error;
    await audit(
      failure instanceof HttpError ? failure.status : 500,
      failure instanceof HttpError ? failure.code : "internal",
    );
    throw failure;
  }

  private expireIdempotency(): void {
    const cutoff = this.clock() - IDEMPOTENCY_TTL_MS;
    for (const [slot, stored] of this.idempotent) {
      if (stored.at < cutoff) this.idempotent.delete(slot);
    }
  }
}
