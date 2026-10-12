import type { Issue, IssueStore, Occurrence } from "@matrix/monitor";
import { PrivateState } from "../private-state.js";
import type { PrivateStateOwner } from "../state-owner.js";

interface State {
  issues: Record<string, Issue>;
  seen: string[];
  occurrences: Record<string, Record<string, Occurrence>>;
}

export class PersistentIssueStore implements IssueStore {
  private readonly state: PrivateState<State>;
  private readonly value: State;
  private readonly leases = new Map<string, { owner: string; until: number }>();

  constructor(
    file?: string,
    private readonly owner?: PrivateStateOwner,
  ) {
    if (file && !owner) throw new Error("durable monitor store requires lifetime ownership");
    this.state = new PrivateState(file, owner);
    this.value = this.state.load({ issues: {}, seen: [], occurrences: {} });
  }

  async get(fingerprint: string): Promise<Issue | null> {
    return structuredClone(this.value.issues[fingerprint] ?? null);
  }

  async save(issue: Issue): Promise<void> {
    this.owner?.assertOwned();
    this.value.issues[issue.fingerprint] = structuredClone(issue);
    this.state.save(this.value);
  }

  async list(projectId?: string): Promise<Issue[]> {
    return structuredClone(
      Object.values(this.value.issues).filter(
        (issue) => !projectId || issue.projectId === projectId,
      ),
    );
  }

  async seen(key: string): Promise<boolean> {
    return this.value.seen.includes(key);
  }

  async markSeen(key: string): Promise<void> {
    this.owner?.assertOwned();
    if (!this.value.seen.includes(key)) this.value.seen.push(key);
    this.state.save(this.value);
  }

  async addOccurrence(fingerprint: string, occurrence: Occurrence): Promise<void> {
    this.owner?.assertOwned();
    this.value.occurrences[fingerprint] ??= {};
    this.value.occurrences[fingerprint][occurrence.signalId] = structuredClone(occurrence);
    this.state.save(this.value);
  }

  async occurrences(fingerprint: string, from: string, to: string): Promise<Occurrence[]> {
    return structuredClone(
      Object.values(this.value.occurrences[fingerprint] ?? {}).filter(
        (occurrence) =>
          Date.parse(occurrence.at) >= Date.parse(from) &&
          Date.parse(occurrence.at) < Date.parse(to),
      ),
    );
  }

  async claim(fingerprint: string, owner: string, ttlMs: number, now: string): Promise<boolean> {
    this.owner?.assertOwned();
    const held = this.leases.get(fingerprint);
    const time = Date.parse(now);
    if (held && held.owner !== owner && held.until > time) return false;
    this.leases.set(fingerprint, { owner, until: time + ttlMs });
    return true;
  }

  async release(fingerprint: string, owner: string): Promise<void> {
    if (this.leases.get(fingerprint)?.owner === owner) this.leases.delete(fingerprint);
  }
}
