import type { Ticket, TicketStatus, TrackerPhase } from "../types.js";
import { joinBody, type MatrixMeta } from "./github.js";
import { sanitizeUntrusted } from "./linear-client.js";
import { findLegacyBlock } from "./linear-meta.js";
import type { LinearIssue } from "./linear-queries.js";

/** Linear workflow state names Matrix moves issues into for coarse ticket statuses. */
export interface LinearStateNames {
  open: string;
  ready: string;
  in_progress: string;
  review: string;
  qa: string;
  done: string;
  closed: string;
}

export const DEFAULT_STATE_NAMES: LinearStateNames = {
  open: "Todo",
  ready: "Ready",
  in_progress: "Implement",
  review: "Review",
  qa: "QA",
  done: "Done",
  closed: "Canceled",
};

/** Board column per Matrix phase while a workflow runs or waits for approval. */
export type LinearPhaseColumns = Partial<Record<string, string>>;

export const DEFAULT_PHASE_COLUMNS: LinearPhaseColumns = {
  spike: "Spike",
  design: "Implement",
  implement: "Implement",
  checks: "Implement",
  review: "Review",
  qa: "QA",
  merge: "Awaiting merge",
};

/**
 * Column for a workflow position, or undefined when the issue should stay where it is: pending
 * (queued or backing off) and blocked keep the current column, unknown phases are not moved.
 */
export function columnFor(
  position: TrackerPhase,
  names: LinearStateNames,
  phases: LinearPhaseColumns,
): string | undefined {
  if (position.status === "done") return names.done;
  if (position.status !== "running" && position.status !== "waiting_approval") return undefined;
  return Object.hasOwn(phases, position.phase) ? phases[position.phase] : undefined;
}

const TERMINAL_TYPES = new Set(["completed", "canceled"]);
export const isTerminal = (stateType: string) => TERMINAL_TYPES.has(stateType);

const norm = (s: string) => s.trim().toLowerCase();

export function statusFromState(
  state: { name: string; type: string },
  names: LinearStateNames,
  blocked: boolean,
): TicketStatus {
  if (state.type === "completed") return "done";
  if (state.type === "canceled") return "closed";
  if (blocked) return "blocked";
  const name = norm(state.name);
  if (name === norm(names.ready)) return "ready";
  if (name === norm(names.review) || name === "awaiting merge") return "review";
  if (name === norm(names.qa)) return "qa";
  if (state.type === "started") return "in_progress";
  return "open";
}

/** Matrix priority is 0 (highest)..4; Linear is 1 (urgent)..4 (low) with 0 = none. */
export function toLinearPriority(p: Ticket["priority"]): number {
  return p === undefined ? 0 : Math.min(p + 1, 4);
}

export function fromLinearPriority(p: number): Ticket["priority"] | undefined {
  if (!Number.isInteger(p) || p < 1 || p > 4) return undefined;
  return (p - 1) as Ticket["priority"];
}

/** Matrix-only fields (phase, blocked flag) ride in the same hidden body block as GitHub. */
export interface LinearMeta extends MatrixMeta {
  blocked?: boolean;
  /** Board column the issue was in when Matrix blocked it (a move away from it re-queues). */
  blockedIn?: string;
  /** Comment ids of Matrix's live comments, by key (see `upsertComment`). */
  comments?: Record<string, string>;
  /** Column Matrix itself last moved the issue into (host-side only; history lags). */
  lastState?: string;
}

const COMMENT_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
const COMMENT_ID = /^[A-Za-z0-9-]{1,64}$/;
export const isCommentKey = (key: string) => COMMENT_KEY.test(key);

function safeComments(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value).slice(0, 20))
    if (COMMENT_KEY.test(k) && typeof v === "string" && COMMENT_ID.test(v)) out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

/** Validates untrusted meta (a legacy description block, or a host file) field by field. */
export function safeMeta(meta: Record<string, unknown>): LinearMeta {
  const safe: LinearMeta = {};
  if (typeof meta.phase === "string" && meta.phase.length <= 80) safe.phase = meta.phase;
  if (meta.blocked === true) safe.blocked = true;
  const blockedIn = meta.blockedIn;
  if (safe.blocked && typeof blockedIn === "string" && blockedIn.length <= 80)
    safe.blockedIn = blockedIn;
  const comments = safeComments(meta.comments);
  if (comments) safe.comments = comments;
  if (typeof meta.lastState === "string" && meta.lastState.length <= 80)
    safe.lastState = meta.lastState;
  return safe;
}

/** Description text and the legacy hidden block's meta (empty when there is none). */
export function readBody(description: string | null): { text: string; meta: LinearMeta } {
  const block = findLegacyBlock(description);
  if (!block) return { text: sanitizeUntrusted(description ?? ""), meta: {} };
  return { text: sanitizeUntrusted(block.text), meta: safeMeta(block.meta) };
}

/** Legacy mode only (no host meta store): text plus the hidden block. */
export function writeBody(text: string, meta: LinearMeta): string {
  const { lastState: _host, ...clean } = safeMeta(meta as Record<string, unknown>);
  return joinBody(text, clean);
}

/** `meta` is the issue's host-side meta when known; else the legacy block is read. */
export function toTicket(
  issue: LinearIssue,
  names: LinearStateNames,
  hostMeta?: LinearMeta,
): Ticket {
  const body = readBody(issue.description);
  const text = body.text;
  const meta = hostMeta ?? body.meta;
  const deps = issue.inverseRelations.nodes
    .filter((r) => r.type === "blocks")
    .map((r) => r.issue.identifier);
  const priority = fromLinearPriority(issue.priority);
  const assignee = issue.assignee?.displayName || issue.assignee?.name;
  return {
    id: issue.identifier,
    title: sanitizeUntrusted(issue.title),
    body: text,
    status: statusFromState(issue.state, names, meta.blocked === true),
    labels: issue.labels.nodes.map((l) => sanitizeUntrusted(l.name)),
    deps: [...new Set(deps)],
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    url: issue.url,
    ...(priority !== undefined ? { priority } : {}),
    ...(issue.parent ? { parent: issue.parent.identifier } : {}),
    ...(meta.phase ? { phase: sanitizeUntrusted(meta.phase) } : {}),
    ...(assignee ? { assignee: sanitizeUntrusted(assignee) } : {}),
  };
}

/** Unresolved blockers: `blocks` relations whose blocking issue is not completed/canceled. */
export function openBlockers(issue: LinearIssue): string[] {
  return issue.inverseRelations.nodes
    .filter((r) => r.type === "blocks" && !isTerminal(r.issue.state.type))
    .map((r) => r.issue.identifier);
}
