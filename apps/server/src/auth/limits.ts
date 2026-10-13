import { appendFileSync } from "node:fs";
import { PrivateState } from "../private-state.js";
import type { PrivateStateOwner } from "../state-owner.js";
import type { KeyBudget } from "./keys.js";

export type Clock = () => number;

/** Token bucket per key: `perMinute` capacity, refilled continuously. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly clock: Clock = Date.now) {}

  take(keyId: string, perMinute: number): { ok: boolean; retryAfterSec: number } {
    const now = this.clock();
    const bucket = this.buckets.get(keyId) ?? { tokens: perMinute, at: now };
    const refill = ((now - bucket.at) / 60_000) * perMinute;
    bucket.tokens = Math.min(perMinute, bucket.tokens + refill);
    bucket.at = now;
    if (bucket.tokens < 1) {
      this.buckets.set(keyId, bucket);
      return { ok: false, retryAfterSec: Math.ceil(((1 - bucket.tokens) / perMinute) * 60) };
    }
    bucket.tokens -= 1;
    this.buckets.set(keyId, bucket);
    return { ok: true, retryAfterSec: 0 };
  }
}

export type BudgetKind = "runs" | "mutations";

/** Daily (UTC) usage counters per key, checked before a mutating call is executed. */
export class BudgetTracker {
  private readonly usage = new Map<string, number>();

  private readonly state: PrivateState<[string, number][]>;

  constructor(
    private readonly clock: Clock = Date.now,
    file?: string,
    owner?: PrivateStateOwner,
  ) {
    this.state = new PrivateState(file, owner);
    for (const [slot, used] of this.state.load([])) this.usage.set(slot, used);
  }

  private slot(keyId: string, kind: BudgetKind): string {
    return `${keyId}:${kind}:${new Date(this.clock()).toISOString().slice(0, 10)}`;
  }

  consume(keyId: string, budget: KeyBudget, kind: BudgetKind): boolean {
    const limit = kind === "runs" ? budget.runsPerDay : budget.mutationsPerDay;
    const slot = this.slot(keyId, kind);
    const used = this.usage.get(slot) ?? 0;
    if (limit !== undefined && used >= limit) return false;
    this.usage.set(slot, used + 1);
    this.state.save([...this.usage]);
    return true;
  }

  used(keyId: string, kind: BudgetKind): number {
    return this.usage.get(this.slot(keyId, kind)) ?? 0;
  }
}

export interface AuditEntry {
  at: string;
  keyId: string;
  action: string;
  method: string;
  path: string;
  projectId?: string;
  status: number;
  detail?: string;
}

/** Append-only audit log of every mutating call; optionally mirrored to a JSONL file. */
export class AuditLog {
  private readonly entries: AuditEntry[] = [];

  constructor(
    private readonly file?: string,
    private readonly max = 10_000,
    private readonly owner?: PrivateStateOwner,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    this.owner?.assertOwned();
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.shift();
    if (this.file) {
      this.owner?.assertOwned();
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    }
  }

  list(filter?: { keyId?: string; projectId?: string }): AuditEntry[] {
    return this.entries.filter(
      (e) =>
        (!filter?.keyId || e.keyId === filter.keyId) &&
        (!filter?.projectId || e.projectId === filter.projectId),
    );
  }
}
