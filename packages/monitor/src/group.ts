import { instructionFlags } from "./injection.js";
import { shortHash } from "./normalize/util.js";
import type { Signal, SignalLevel, SignalProvider, StackFrame } from "./signal.js";

const LEVEL_RANK: Record<SignalLevel, number> = { info: 0, warning: 1, error: 2, fatal: 3 };
const MAX_USER_HASHES = 10_000;

export type IssueStatus =
  | "new"
  | "triaged"
  | "ticketed"
  | "human"
  | "verifying"
  | "resolved"
  | "reopened";

export type Trust = Signal["trust"];

/** Which source's content an issue shows: server-side code evidence first, then infra, then client. */
export const TRUST_RANK: Record<Trust, number> = { client: 0, infra: 1, server: 2 };

export interface ReleaseStats {
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface Occurrence {
  signalId: string;
  at: string;
  count: number;
  release?: string;
}

/**
 * A group of signals that share a root cause. All text is already redacted.
 * Evidence fields (title, message, exceptionType, frames, urls) come from the most trusted
 * source seen so far (`evidenceTrust`); lower-trust signals only add counts, never content.
 */
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
  /** Trust levels of the signals in this issue (see Signal.trust). */
  trust: Trust[];
  /** Trust level of the signal the evidence fields were taken from. */
  evidenceTrust: Trust;
  /** Instruction-like content found in the evidence (see injection.ts). */
  flags: string[];
  environments: string[];
  releases: Record<string, ReleaseStats>;
  firstSeen: string;
  lastSeen: string;
  count: number;
  /** Hashed distinct users (capped). */
  userHashes: string[];
  /** Highest distinct-user count reported by a provider for this issue. */
  reportedUsers: number;
  urls: string[];
  status: IssueStatus;
  ticketId?: string;
  fixRelease?: string;
  /** Last triage/ticketing failure, retried on the next tick. */
  lastError?: string;
}

/** Distinct users: provider aggregate or our own hashed set, whichever is larger. */
export const distinctUsers = (issue: Pick<Issue, "userHashes" | "reportedUsers">) =>
  Math.max(issue.userHashes.length, issue.reportedUsers);

/** Port: issue persistence. The server/core can back this with Postgres. */
export interface IssueStore {
  get(fingerprint: string): Promise<Issue | null>;
  save(issue: Issue): Promise<void>;
  list(projectId?: string): Promise<Issue[]>;
  seen(key: string): Promise<boolean>;
  markSeen(key: string): Promise<void>;
  /** Idempotent per `occurrence.signalId`. */
  addOccurrence(fingerprint: string, occurrence: Occurrence): Promise<void>;
  occurrences(fingerprint: string, from: string, to: string): Promise<Occurrence[]>;
  /**
   * Atomic lease on one issue for one worker (a unique row / `INSERT … ON CONFLICT` in SQL).
   * Returns false while another worker holds an unexpired lease.
   */
  claim(fingerprint: string, owner: string, ttlMs: number, now: string): Promise<boolean>;
  release(fingerprint: string, owner: string): Promise<void>;
}

export class MemoryIssueStore implements IssueStore {
  private issues = new Map<string, Issue>();
  private signals = new Set<string>();
  private occ = new Map<string, Map<string, Occurrence>>();
  private leases = new Map<string, { owner: string; until: number }>();

  async claim(fp: string, owner: string, ttlMs: number, now: string) {
    // No await between the check and the write, so this is atomic within the process.
    const t = Date.parse(now);
    const held = this.leases.get(fp);
    if (held && held.owner !== owner && held.until > t) return false;
    this.leases.set(fp, { owner, until: t + ttlMs });
    return true;
  }
  async release(fp: string, owner: string) {
    if (this.leases.get(fp)?.owner === owner) this.leases.delete(fp);
  }

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
  async seen(key: string) {
    return this.signals.has(key);
  }
  async markSeen(key: string) {
    this.signals.add(key);
  }
  async addOccurrence(fp: string, o: Occurrence) {
    const byId = this.occ.get(fp) ?? new Map<string, Occurrence>();
    byId.set(o.signalId, o);
    this.occ.set(fp, byId);
  }
  async occurrences(fp: string, from: string, to: string) {
    const a = Date.parse(from);
    const b = Date.parse(to);
    return [...(this.occ.get(fp)?.values() ?? [])].filter((o) => {
      const t = Date.parse(o.at);
      return t >= a && t < b;
    });
  }
}

/**
 * Masks volatile tokens so "order 123456 failed" and "order 99881 failed" group together.
 * Numbers of 1-3 digits (HTTP status codes, small counts) are kept: "HTTP 404" ≠ "HTTP 500".
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\b0x[0-9a-f]+\b/g, "<hex>")
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{12,}\b/g, "<hex>")
    .replace(/\d{4,}/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/** Frames that wrap every error (error boundaries, async handlers, loggers) don't identify a bug. */
const WRAPPER_FN =
  /^(errorBoundary|componentDidCatch|asyncHandler|catchAsync|wrap\w*|handleErrors?|withErrorHandl\w*|captureException|logError|reportError|onError|errorHandler|next)$/i;

export function significantFrames(frames: StackFrame[]): StackFrame[] {
  return frames.filter((f) => f.inApp && !(f.function && WRAPPER_FN.test(f.function)));
}

/**
 * Grouping key, scoped by project:
 * - errors with in-app frames: exception type + normalized message + top 3 non-wrapper in-app frames
 *   (file + function, no line numbers so unrelated edits don't split a group);
 * - otherwise the provider's own fingerprint plus the exception type;
 * - otherwise the normalized title.
 */
export function fingerprintOf(s: Signal): string {
  const frames = significantFrames(s.frames).slice(0, 3);
  if (s.kind === "error" && frames.length > 0) {
    const sig = frames.map((f) => `${f.file}:${f.function ?? "?"}`).join("|");
    return `st:${shortHash(s.projectId, s.exceptionType ?? "", normalizeTitle(s.message).slice(0, 120), sig)}`;
  }
  if (s.providerFingerprint) {
    return `pf:${shortHash(s.projectId, s.provider, s.exceptionType ?? "", s.providerFingerprint)}`;
  }
  return `tt:${shortHash(s.projectId, s.kind, s.exceptionType ?? "", normalizeTitle(s.title))}`;
}

/** Dedupe key: provider event ids are only unique within a provider and a project. */
export const seenKey = (s: Signal) => `${s.projectId}\u0000${s.id}`;

const minIso = (a: string, b: string) => (Date.parse(a) <= Date.parse(b) ? a : b);
const maxIso = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);
const addUnique = <T>(list: T[], v: T | undefined) =>
  v === undefined || list.includes(v) ? list : [...list, v];

export interface IngestResult {
  issue: Issue;
  isNew: boolean;
  /** The issue had been resolved and this signal shows it again. */
  recurred: boolean;
  signal: Signal;
}

function fresh(fp: string, s: Signal): Issue {
  const issue: Issue = {
    fingerprint: fp,
    projectId: s.projectId,
    kind: s.kind,
    title: s.title,
    message: s.message,
    level: s.level,
    frames: s.frames,
    providers: [s.provider],
    trust: [s.trust],
    evidenceTrust: s.trust,
    flags: [],
    environments: [],
    releases: {},
    firstSeen: s.occurredAt,
    lastSeen: s.occurredAt,
    count: 0,
    userHashes: [],
    reportedUsers: 0,
    urls: [],
    status: "new",
  };
  if (s.exceptionType) issue.exceptionType = s.exceptionType;
  return issue;
}

function fold(issue: Issue, s: Signal): void {
  issue.count += s.count;
  issue.firstSeen = minIso(issue.firstSeen, s.occurredAt);
  issue.lastSeen = maxIso(issue.lastSeen, s.occurredAt);
  if (LEVEL_RANK[s.level] > LEVEL_RANK[issue.level]) issue.level = s.level;
  const rank = TRUST_RANK[s.trust] - TRUST_RANK[issue.evidenceTrust];
  if (rank > 0) {
    // A more trusted source replaces the evidence entirely: no client content in a server ticket.
    issue.evidenceTrust = s.trust;
    issue.title = s.title;
    issue.message = s.message;
    issue.frames = s.frames;
    issue.urls = s.url ? [s.url] : [];
    if (s.exceptionType) issue.exceptionType = s.exceptionType;
    else delete issue.exceptionType;
  } else if (rank === 0) {
    if (issue.frames.length === 0 && s.frames.length > 0) issue.frames = s.frames;
    issue.urls = addUnique(issue.urls, s.url).slice(0, 10);
  }
  issue.providers = addUnique(issue.providers, s.provider);
  issue.trust = addUnique(issue.trust, s.trust);
  issue.environments = addUnique(issue.environments, s.environment);
  issue.reportedUsers = Math.max(issue.reportedUsers, s.reportedUsers);
  for (const h of s.userHashes) {
    if (issue.userHashes.length >= MAX_USER_HASHES) break;
    if (!issue.userHashes.includes(h)) issue.userHashes.push(h);
  }
  const flags = instructionFlags([
    s.title,
    s.message,
    s.exceptionType,
    s.url,
    ...s.frames.flatMap((f) => [f.file, f.function]),
  ]);
  for (const f of flags) issue.flags = addUnique(issue.flags, f);
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
}

/**
 * Folds each signal into its issue. Order makes it safe to retry after a crash: the occurrence
 * (idempotent per signal id) and the issue are written first, the signal is marked seen last.
 */
export async function ingest(store: IssueStore, signals: Signal[]): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (const s of signals) {
    const key = seenKey(s);
    if (await store.seen(key)) continue;
    const fp = fingerprintOf(s);
    const existing = await store.get(fp);
    const issue = existing ?? fresh(fp, s);
    const recurred = issue.status === "resolved";
    if (recurred) issue.status = "reopened";
    fold(issue, s);

    const occurrence: Occurrence = { signalId: key, at: s.occurredAt, count: s.count };
    if (s.release) occurrence.release = s.release;
    await store.addOccurrence(fp, occurrence);
    await store.save(issue);
    await store.markSeen(key);
    results.push({ issue, isNew: !existing, recurred, signal: s });
  }
  return results;
}
