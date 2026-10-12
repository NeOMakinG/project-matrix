import { shortHash } from "./normalize/util.js";
import type { Signal, SignalLevel, SignalProvider, StackFrame } from "./signal.js";

const LEVEL_RANK: Record<SignalLevel, number> = { info: 0, warning: 1, error: 2, fatal: 3 };

export type IssueStatus =
  | "new"
  | "triaged"
  | "ticketed"
  | "human"
  | "verifying"
  | "resolved"
  | "reopened";

export interface ReleaseStats {
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface Occurrence {
  at: string;
  count: number;
  release?: string;
}

/** A group of signals that share a root cause. */
export interface Issue {
  fingerprint: string;
  projectId: string;
  kind: Signal["kind"];
  title: string;
  message: string;
  level: SignalLevel;
  exceptionType?: string;
  frames: StackFrame[];
  providers: SignalProvider[];
  environments: string[];
  releases: Record<string, ReleaseStats>;
  firstSeen: string;
  lastSeen: string;
  count: number;
  users: number;
  urls: string[];
  status: IssueStatus;
  ticketId?: string;
  fixRelease?: string;
}

/** Port: issue persistence. The server/core can back this with Postgres. */
export interface IssueStore {
  get(fingerprint: string): Promise<Issue | null>;
  save(issue: Issue): Promise<void>;
  list(projectId?: string): Promise<Issue[]>;
  seen(signalId: string): Promise<boolean>;
  markSeen(signalId: string): Promise<void>;
  addOccurrence(fingerprint: string, occurrence: Occurrence): Promise<void>;
  occurrences(fingerprint: string, from: string, to: string): Promise<Occurrence[]>;
}

export class MemoryIssueStore implements IssueStore {
  private issues = new Map<string, Issue>();
  private signals = new Set<string>();
  private occ = new Map<string, Occurrence[]>();

  async get(fp: string) {
    const i = this.issues.get(fp);
    return i ? structuredClone(i) : null;
  }
  async save(issue: Issue) {
    this.issues.set(issue.fingerprint, structuredClone(issue));
  }
  async list(projectId?: string) {
    return [...this.issues.values()]
      .filter((i) => !projectId || i.projectId === projectId)
      .map((i) => structuredClone(i));
  }
  async seen(id: string) {
    return this.signals.has(id);
  }
  async markSeen(id: string) {
    this.signals.add(id);
  }
  async addOccurrence(fp: string, o: Occurrence) {
    const list = this.occ.get(fp) ?? [];
    list.push(o);
    this.occ.set(fp, list);
  }
  async occurrences(fp: string, from: string, to: string) {
    const a = Date.parse(from);
    const b = Date.parse(to);
    return (this.occ.get(fp) ?? []).filter((o) => {
      const t = Date.parse(o.at);
      return t >= a && t < b;
    });
  }
}

/** Replace volatile tokens so "order 1234 failed" and "order 99 failed" group together. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\b0x[0-9a-f]+\b/g, "<hex>")
    .replace(/\b[0-9a-f]{12,}\b/g, "<hex>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Grouping key. Stack-based when in-app frames exist (exception type + top 3 in-app frames,
 * without line numbers so unrelated edits don't split a group); otherwise the provider's own
 * fingerprint; otherwise the normalized title.
 */
export function fingerprintOf(s: Signal): string {
  const inApp = s.frames.filter((f) => f.inApp).slice(0, 3);
  if (s.kind === "error" && inApp.length > 0) {
    const sig = inApp.map((f) => `${f.file}:${f.function ?? "?"}`).join("|");
    return `st:${shortHash(s.projectId, s.exceptionType ?? "", sig)}`;
  }
  if (s.providerFingerprint) {
    return `pf:${shortHash(s.projectId, s.provider, s.providerFingerprint)}`;
  }
  return `tt:${shortHash(s.projectId, s.kind, s.exceptionType ?? "", normalizeTitle(s.title))}`;
}

const minIso = (a: string, b: string) => (Date.parse(a) <= Date.parse(b) ? a : b);
const maxIso = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);
const addUnique = <T>(list: T[], v: T | undefined) =>
  v === undefined || list.includes(v) ? list : [...list, v];

export interface IngestResult {
  issue: Issue;
  isNew: boolean;
  /** The issue had been resolved or ticketed and this signal shows it again. */
  recurred: boolean;
  signal: Signal;
}

/** Dedupes by signal id and folds each signal into its issue. */
export async function ingest(store: IssueStore, signals: Signal[]): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (const s of signals) {
    if (await store.seen(s.id)) continue;
    await store.markSeen(s.id);
    const fp = fingerprintOf(s);
    const existing = await store.get(fp);
    const occurrence: Occurrence = { at: s.occurredAt, count: s.count };
    if (s.release) occurrence.release = s.release;
    await store.addOccurrence(fp, occurrence);

    if (!existing) {
      const issue: Issue = {
        fingerprint: fp,
        projectId: s.projectId,
        kind: s.kind,
        title: s.title,
        message: s.message,
        level: s.level,
        frames: s.frames,
        providers: [s.provider],
        environments: s.environment ? [s.environment] : [],
        releases: s.release
          ? { [s.release]: { count: s.count, firstSeen: s.occurredAt, lastSeen: s.occurredAt } }
          : {},
        firstSeen: s.occurredAt,
        lastSeen: s.occurredAt,
        count: s.count,
        users: s.users,
        urls: s.url ? [s.url] : [],
        status: "new",
      };
      if (s.exceptionType) issue.exceptionType = s.exceptionType;
      await store.save(issue);
      results.push({ issue, isNew: true, recurred: false, signal: s });
      continue;
    }

    const issue = existing;
    const recurred = issue.status === "resolved";
    if (recurred) issue.status = "reopened";
    issue.count += s.count;
    issue.users += s.users;
    issue.firstSeen = minIso(issue.firstSeen, s.occurredAt);
    issue.lastSeen = maxIso(issue.lastSeen, s.occurredAt);
    if (LEVEL_RANK[s.level] > LEVEL_RANK[issue.level]) issue.level = s.level;
    if (issue.frames.length === 0 && s.frames.length > 0) issue.frames = s.frames;
    issue.providers = addUnique(issue.providers, s.provider);
    issue.environments = addUnique(issue.environments, s.environment);
    issue.urls = addUnique(issue.urls, s.url).slice(0, 10);
    if (s.release) {
      const r = issue.releases[s.release];
      issue.releases[s.release] = r
        ? {
            count: r.count + s.count,
            firstSeen: minIso(r.firstSeen, s.occurredAt),
            lastSeen: maxIso(r.lastSeen, s.occurredAt),
          }
        : { count: s.count, firstSeen: s.occurredAt, lastSeen: s.occurredAt };
    }
    await store.save(issue);
    results.push({ issue, isNew: false, recurred, signal: s });
  }
  return results;
}
