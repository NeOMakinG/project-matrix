import type { BusEvent, EventBus, Store } from "@matrix/core";
import type { Ticket } from "@matrix/tickets";
import type { StoredProject } from "./mapping.js";

export interface DeckConfig {
  name: string;
  url: string;
  key: string;
}

export interface DeckLifecycleOptions {
  bus: EventBus;
  store: Store;
  decks: Map<string, DeckConfig>;
  repoToDeck: Map<string, string>;
  log?: (msg: string) => void;
  /** Override for testing; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Retry delays in ms for 429 responses. Override to [0,0,0] in tests. Default: [2000,4000,8000]. */
  retryDelays?: number[];
}

interface CachedTask {
  deckName: string;
  taskId: string;
}

const DEFAULT_RETRY_DELAYS = [2_000, 4_000, 8_000];

/**
 * DeckLifecycle: subscribes to the Matrix EventBus and mirrors ticket lifecycle to EagleRay decks.
 * One deck per "deck name" (delta/tj/station), each with its own API key.
 * Project → deck mapping via MATRIX_DECK_REPOS env JSON: {"NeOMakinG/wayline":"tj","NeOMakinG/ai-company":"delta"}
 */
export class DeckLifecycle {
  readonly #fetch: typeof globalThis.fetch;
  readonly #retryDelays: number[];
  readonly #o: Required<Omit<DeckLifecycleOptions, "fetch" | "retryDelays">>;
  /** projectId:ticketId → { deckName, taskId } */
  readonly #taskCache = new Map<string, CachedTask>();
  /** runId → projectId:ticketId key */
  readonly #runs = new Map<string, string>();
  #unsubscribe: (() => void) | undefined = undefined;

  constructor(options: DeckLifecycleOptions) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#retryDelays = options.retryDelays ?? DEFAULT_RETRY_DELAYS;
    const { fetch: _f, retryDelays: _r, log, ...rest } = options;
    this.#o = { log: log ?? (() => {}), ...rest };
  }

  start(): () => void {
    if (!this.#unsubscribe) {
      this.#unsubscribe = this.#o.bus.subscribe((event) => {
        void this.#on(event).catch((err) => {
          this.#o.log(
            `deck-lifecycle: unhandled error: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      });
    }
    return () => this.stop();
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  async #deckFetchWithRetry(
    url: string,
    key: string,
    method: string,
    body?: unknown,
  ): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.#retryDelays.length; attempt++) {
      try {
        const init: RequestInit = {
          method,
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(15_000),
        };
        if (body !== undefined) init.body = JSON.stringify(body);
        const res = await this.#fetch(url, init);
        if (res.status === 429 && attempt < this.#retryDelays.length) {
          await new Promise((resolve) => setTimeout(resolve, this.#retryDelays[attempt]));
          continue;
        }
        return res;
      } catch (err) {
        lastErr = err;
        if (attempt < this.#retryDelays.length) {
          await new Promise((resolve) => setTimeout(resolve, this.#retryDelays[attempt]));
        }
      }
    }
    throw lastErr;
  }

  async #getProjectLabel(projectId: string): Promise<string | undefined> {
    try {
      const project = (await this.#o.store.getProject(projectId)) as StoredProject | null;
      return project?.matrix?.tickets?.linear?.projectLabel ?? undefined;
    } catch {
      return undefined;
    }
  }

  #getDeckConfig(label: string): DeckConfig | undefined {
    const deckName = this.#o.repoToDeck.get(label);
    if (!deckName) return undefined;
    return this.#o.decks.get(deckName);
  }

  async #on(event: BusEvent): Promise<void> {
    if (event.type === "run.started") {
      const key = `${event.projectId}:${event.ticketId}`;
      this.#runs.set(event.runId, key);
      if (this.#runs.size > 2_000) this.#runs.delete(this.#runs.keys().next().value as string);

      if (event.phase === "spike") {
        await this.#onTicketPickup(event.projectId, event.ticketId);
      }
    } else if (event.type === "pull_request.opened") {
      await this.#onPrOpened(event.projectId, event.ticketId, event.url, event.branch);
    } else if (event.type === "run.finished") {
      const key = this.#runs.get(event.runId);
      this.#runs.delete(event.runId);
      if (key) {
        await this.#onRunFinished(key, event.status, event.summary);
      }
    } else if (event.type === "workflow.blocked") {
      await this.#onWorkflowBlocked(event.projectId, event.ticketId, event.reason);
    } else if (event.type === "workflow.changed") {
      const w = event.workflow;
      if (w.status === "done") {
        await this.#onWorkflowDone(w.projectId, w.ticketId);
      }
    }
  }

  async #onTicketPickup(projectId: string, ticketId: string): Promise<void> {
    const label = await this.#getProjectLabel(projectId);
    if (!label) return;
    const deck = this.#getDeckConfig(label);
    if (!deck) return;

    let ticket: Ticket | null = null;
    try {
      ticket = await this.#o.store.getIndexedTicket(projectId, ticketId);
    } catch {
      // fall through with null ticket
    }

    const title = ticket?.title ?? ticketId;
    const linearUrl = ticket?.url ?? undefined;
    const linearId = ticketId;
    const base = deck.url.replace(/\/$/, "");

    // Dedupe: search for an existing open task with this linearId
    try {
      const searchRes = await this.#deckFetchWithRetry(
        `${base}/tasks?q=${encodeURIComponent(`linearId:${linearId}`)}`,
        deck.key,
        "GET",
      );
      if (searchRes.ok) {
        type SearchResult = { tasks?: Array<{ id: string; status?: string }> };
        const data = (await searchRes.json()) as SearchResult | undefined;
        const existing = data?.tasks?.find((t) => t.status !== "done" && t.status !== "closed");
        if (existing) {
          // Another agent's open task found — post a note instead of creating a duplicate
          const cacheKey = `${projectId}:${ticketId}`;
          this.#taskCache.set(cacheKey, { deckName: deck.name, taskId: existing.id });
          await this.#postActivity(
            deck,
            existing.id,
            `Matrix picked up ticket: ${title}${linearUrl ? ` (${linearUrl})` : ""}`,
          );
          return;
        }
      }
    } catch (err) {
      this.#o.log(
        `deck-lifecycle: search failed for ${linearId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Create a new deck task
    const description = [
      linearUrl ? `Linear: ${linearUrl}` : null,
      `linearId:${linearId}`,
      `label:${label}`,
      `Picked up by Matrix factory.`,
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const res = await this.#deckFetchWithRetry(`${base}/tasks`, deck.key, "POST", {
        title,
        status: "in_progress",
        description,
      });
      if (res.ok) {
        type CreateResult = { id?: string; task?: { id: string } };
        const body = (await res.json()) as CreateResult | undefined;
        const taskId = body?.id ?? body?.task?.id;
        if (taskId) {
          const cacheKey = `${projectId}:${ticketId}`;
          this.#taskCache.set(cacheKey, { deckName: deck.name, taskId });
          this.#o.log(
            `deck-lifecycle: created task ${taskId} for ${linearId} on deck ${deck.name}`,
          );
        }
      } else {
        this.#o.log(`deck-lifecycle: task create failed HTTP ${res.status} for ${linearId}`);
      }
    } catch (err) {
      this.#o.log(
        `deck-lifecycle: task create error for ${linearId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async #onPrOpened(
    projectId: string,
    ticketId: string,
    url: string,
    branch: string,
  ): Promise<void> {
    const cached = this.#taskCache.get(`${projectId}:${ticketId}`);
    if (!cached) return;
    const deck = this.#o.decks.get(cached.deckName);
    if (!deck) return;
    await this.#postActivity(deck, cached.taskId, `PR opened: ${branch} — ${url}`);
  }

  async #onRunFinished(key: string, status: string, summary: string): Promise<void> {
    const cached = this.#taskCache.get(key);
    if (!cached) return;
    const deck = this.#o.decks.get(cached.deckName);
    if (!deck) return;
    await this.#postActivity(
      deck,
      cached.taskId,
      `QA run finished: ${status}${summary ? ` — ${summary}` : ""}`,
    );
  }

  async #onWorkflowBlocked(projectId: string, ticketId: string, reason: string): Promise<void> {
    const cached = this.#taskCache.get(`${projectId}:${ticketId}`);
    if (!cached) return;
    const deck = this.#o.decks.get(cached.deckName);
    if (!deck) return;
    await this.#patchTaskStatus(deck, cached.taskId, "blocked", reason);
  }

  async #onWorkflowDone(projectId: string, ticketId: string): Promise<void> {
    const cached = this.#taskCache.get(`${projectId}:${ticketId}`);
    if (!cached) return;
    const deck = this.#o.decks.get(cached.deckName);
    if (!deck) return;
    await this.#patchTaskStatus(deck, cached.taskId, "done");
    this.#taskCache.delete(`${projectId}:${ticketId}`);
  }

  async #postActivity(deck: DeckConfig, taskId: string, summary: string): Promise<void> {
    const base = deck.url.replace(/\/$/, "");
    try {
      const res = await this.#deckFetchWithRetry(`${base}/activities`, deck.key, "POST", {
        scope: "dev",
        action: "update",
        summary,
        entityType: "task",
        entityId: taskId,
      });
      if (!res.ok) {
        this.#o.log(
          `deck-lifecycle: activity post failed HTTP ${res.status}: ${summary.slice(0, 60)}`,
        );
      }
    } catch (err) {
      this.#o.log(
        `deck-lifecycle: activity post error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async #patchTaskStatus(
    deck: DeckConfig,
    taskId: string,
    status: string,
    note?: string,
  ): Promise<void> {
    const base = deck.url.replace(/\/$/, "");
    try {
      const res = await this.#deckFetchWithRetry(`${base}/tasks/${taskId}`, deck.key, "PATCH", {
        status,
        ...(note ? { note } : {}),
      });
      if (!res.ok) {
        this.#o.log(`deck-lifecycle: task PATCH failed HTTP ${res.status} for ${taskId}`);
      }
    } catch (err) {
      this.#o.log(
        `deck-lifecycle: task PATCH error for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
