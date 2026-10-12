import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Clock } from "./limits.js";

export interface ReplayLogOptions {
  /** JSONL-ish file (`<sha256> <epochMs>` per line); without it the log is in memory only. */
  file?: string;
  clock?: Clock;
  /** How long an accepted delivery is remembered. Must exceed the accepted timestamp skew. */
  ttlMs?: number;
}

/**
 * Remembers accepted webhook deliveries / nonces so a captured, validly signed request can't be
 * replayed — including after a restart, when a file is configured. Only hashes are stored. Writes are
 * synchronous and happen before the request is processed, so a crash can't accept a delivery twice.
 */
export class ReplayLog {
  private readonly seen = new Map<string, number>();
  private readonly clock: Clock;
  private readonly ttlMs: number;
  private appended = 0;

  constructor(private readonly options: ReplayLogOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.ttlMs = options.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
    if (options.file && existsSync(options.file)) {
      const cutoff = this.clock() - this.ttlMs;
      for (const line of readFileSync(options.file, "utf8").split("\n")) {
        const [hash, at] = line.split(" ");
        const when = Number(at);
        if (hash && /^[0-9a-f]{64}$/.test(hash) && Number.isFinite(when) && when > cutoff) {
          this.seen.set(hash, when);
        }
      }
      this.compact();
    }
  }

  /** Returns false when `key` was already accepted within the TTL; otherwise records it. */
  accept(key: string): boolean {
    const now = this.clock();
    this.expire(now);
    const hash = createHash("sha256").update(key).digest("hex");
    if (this.seen.has(hash)) return false;
    // Persist first: if the write fails, the request fails and nothing is ingested.
    if (this.options.file) {
      appendFileSync(this.options.file, `${hash} ${now}\n`, { mode: 0o600 });
      this.appended += 1;
      if (this.appended > Math.max(1000, this.seen.size * 2)) this.compact();
    }
    this.seen.set(hash, now);
    return true;
  }

  private expire(now: number): void {
    const cutoff = now - this.ttlMs;
    for (const [hash, at] of this.seen) {
      if (at > cutoff) break;
      this.seen.delete(hash);
    }
  }

  /** Rewrites the file with live entries only (atomic rename). */
  private compact(): void {
    if (!this.options.file) return;
    const tmp = `${this.options.file}.tmp`;
    writeFileSync(tmp, [...this.seen].map(([h, at]) => `${h} ${at}\n`).join(""), { mode: 0o600 });
    renameSync(tmp, this.options.file);
    this.appended = 0;
  }
}
