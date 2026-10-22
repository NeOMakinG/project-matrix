import { type OrcaCli, OrcaCliError, orcaLabel, record, str } from "./orca-cli.js";

/** A message Matrix received on a Run's coordinator mailbox. */
export interface OrcaMessage {
  id: string;
  type: string;
  from: string;
  subject: string;
  body: string;
  payload: Record<string, unknown>;
}

export interface OrcaRunRef {
  runId: string;
  coordinator: string;
  worktree: string;
}

type Waiter = {
  onMessage(message: OrcaMessage): void;
};

/** Fixed answer to worker questions: Matrix runs unattended and never relays ticket text back. */
export const UNATTENDED_REPLY =
  "Matrix runs this phase unattended; no human answers here. Choose the safest option or fail the phase.";

function parsePayload(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return record(value);
}

export function parseCheck(result: unknown): { deliveryId?: string; messages: OrcaMessage[] } {
  const r = record(result);
  const messages = (Array.isArray(r.messages) ? r.messages : []).map(record).flatMap((m) => {
    const id = str(m.id);
    if (!id) return [];
    return [
      {
        id,
        type: str(m.type) ?? "status",
        from: str(m.from_handle) ?? "",
        subject: typeof m.subject === "string" ? m.subject : "",
        body: typeof m.body === "string" ? m.body : "",
        payload: parsePayload(m.payload),
      },
    ];
  });
  const deliveryId = str(r.deliveryId);
  return { ...(deliveryId ? { deliveryId } : {}), messages };
}

/**
 * One ticket's Orca Run: a parked bash coordinator terminal in the ticket worktree bound to one
 * orchestration Run. A single pump drains the coordinator mailbox (acking every Delivery so nothing
 * replays) and routes messages to the dispatch that is waiting for them.
 */
export class OrcaTicketSession {
  readonly #cli: OrcaCli;
  readonly #waiters = new Map<string, Waiter>();
  readonly #seen = new Set<string>();
  #pumping: Promise<void> | undefined;
  #closed = false;
  #ref: OrcaRunRef | undefined;
  #opening: Promise<OrcaRunRef> | undefined;

  constructor(
    cli: OrcaCli,
    readonly worktree: string,
    readonly label: string,
    readonly pollMs = 2_000,
  ) {
    this.#cli = cli;
  }

  get ref(): OrcaRunRef | undefined {
    return this.#ref;
  }

  /** Lazily creates the coordinator terminal and the Run (once; concurrent callers share it). */
  open(): Promise<OrcaRunRef> {
    if (this.#ref) return Promise.resolve(this.#ref);
    this.#opening ??= (async () => {
      const created = record(
        await this.#cli.call([
          "terminal",
          "create",
          "--worktree",
          `path:${this.worktree}`,
          "--title",
          orcaLabel(`matrix:${this.label}`, 60),
          "--command",
          "bash",
          "--json",
        ]),
      );
      const coordinator = str(record(created.terminal).handle);
      if (!coordinator) throw new OrcaCliError("orca terminal create returned no handle");
      const run = record(
        await this.#cli.call([
          "orchestration",
          "run-create",
          "--objective",
          orcaLabel(this.label, 120),
          "--from",
          coordinator,
          "--json",
        ]),
      );
      const runId = str(record(run.run).id);
      if (!runId) throw new OrcaCliError("orca run-create returned no run id");
      this.#ref = { runId, coordinator, worktree: this.worktree };
      return this.#ref;
    })().finally(() => {
      this.#opening = undefined;
    });
    return this.#opening;
  }

  /**
   * Forgets the Run binding (e.g. the coordinator tab was closed in Orca) so the next phase opens
   * a fresh coordinator and Run instead of failing forever.
   */
  invalidate(): void {
    if (this.#waiters.size === 0) this.#ref = undefined;
  }

  /** Registers interest in one dispatch's messages; returns an unsubscribe. */
  watch(dispatchId: string, waiter: Waiter): () => void {
    this.#waiters.set(dispatchId, waiter);
    this.#startPump();
    return () => {
      this.#waiters.delete(dispatchId);
    };
  }

  #startPump(): void {
    this.#pumping ??= this.#pump()
      .catch(() => undefined)
      .finally(() => {
        this.#pumping = undefined;
        // A watcher that registered during the final drain must not be left without a pump.
        if (this.#waiters.size > 0 && !this.#closed) {
          const retry = setTimeout(() => {
            if (this.#waiters.size > 0 && !this.#closed) this.#startPump();
          }, this.pollMs);
          retry.unref?.();
        }
      });
  }

  async #check(ref: OrcaRunRef, ack: string | undefined, wait: boolean) {
    const args = ["orchestration", "check", "--terminal", ref.coordinator, "--run", ref.runId];
    if (ack) args.push("--ack", ack);
    if (wait) args.push("--wait", "--timeout-ms", String(this.pollMs));
    args.push("--json");
    return parseCheck(await this.#cli.call(args, this.pollMs + 30_000));
  }

  async #route(ref: OrcaRunRef, message: OrcaMessage): Promise<void> {
    if (this.#seen.has(message.id)) return;
    this.#seen.add(message.id);
    if (this.#seen.size > 5_000) this.#seen.delete(this.#seen.values().next().value as string);
    if (message.type === "question") {
      await this.#cli
        .call([
          "orchestration",
          "reply",
          "--id",
          message.id,
          "--body",
          UNATTENDED_REPLY,
          "--from",
          ref.coordinator,
          "--run",
          ref.runId,
          "--json",
        ])
        .catch(() => undefined);
    }
    const dispatch = str(message.payload.dispatchId) ?? message.from.replace(/^dispatch:/, "");
    this.#waiters.get(dispatch)?.onMessage(message);
  }

  async #pump(): Promise<void> {
    const ref = await this.open();
    let ack: string | undefined;
    let failures = 0;
    while (this.#waiters.size > 0) {
      try {
        const batch = await this.#check(ref, ack, true);
        ack = batch.deliveryId;
        failures = 0;
        for (const message of batch.messages) await this.#route(ref, message);
      } catch {
        // Transient runtime errors: the launcher still has its exit-file fallback and timeout.
        failures += 1;
        await new Promise((r) => setTimeout(r, Math.min(this.pollMs * failures, 30_000)));
      }
    }
    // Ack the last processed batch, draining anything that arrived meanwhile (bounded).
    for (let i = 0; i < 5 && ack; i++) {
      try {
        const batch = await this.#check(ref, ack, false);
        for (const message of batch.messages) await this.#route(ref, message);
        ack = batch.messages.length > 0 ? batch.deliveryId : undefined;
      } catch {
        return;
      }
    }
  }

  /** Waits for the pump to stop (after the last watcher left). */
  async idle(): Promise<void> {
    await this.#pumping;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#waiters.clear();
    await this.#pumping;
    const ref = this.#ref;
    this.#ref = undefined;
    if (ref)
      await this.#cli
        .call(["terminal", "close", "--terminal", ref.coordinator, "--json"])
        .catch(() => undefined);
  }
}
