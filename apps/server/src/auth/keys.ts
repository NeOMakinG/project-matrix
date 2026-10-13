import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { PrivateStateOwner } from "../state-owner.js";

export const ACTIONS = [
  "read",
  "tickets:write",
  "runs:start",
  "runs:approve",
  "merge",
  "deploy",
  "admin",
] as const;
export type Action = (typeof ACTIONS)[number];

export const KeyScopeSchema = z.object({
  projects: z.union([z.literal("*"), z.array(z.string().min(1)).min(1)]),
  actions: z.array(z.enum(ACTIONS)).min(1),
});
export type KeyScope = z.infer<typeof KeyScopeSchema>;

export const KeyBudgetSchema = z.object({
  runsPerDay: z.number().int().positive().optional(),
  mutationsPerDay: z.number().int().positive().optional(),
});
export type KeyBudget = z.infer<typeof KeyBudgetSchema>;

/** `human` keys belong to a person (dashboard, CLI); `agent` keys belong to automated workers. */
export const KeyKindSchema = z.enum(["human", "agent"]);
export type KeyKind = z.infer<typeof KeyKindSchema>;

export interface ApiKeyRecord {
  id: string;
  name: string;
  kind: KeyKind;
  hash: string;
  scope: KeyScope;
  budget: KeyBudget;
  ratePerMinute: number;
  createdAt: string;
  revokedAt?: string;
  createdByKeyId?: string;
}

export type PublicKey = Omit<ApiKeyRecord, "hash" | "createdByKeyId">;

const TOKEN_RE = /^mx_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;

const hashSecret = (secret: string) => createHash("sha256").update(secret).digest();

export function toPublic(record: ApiKeyRecord): PublicKey {
  const { hash: _hash, createdByKeyId: _createdByKeyId, ...rest } = record;
  return rest;
}

export function hasAction(scope: KeyScope, action: Action): boolean {
  return scope.actions.includes("admin") || scope.actions.includes(action);
}

/**
 * How an operation is scoped:
 * - `project`: targets one project, the key must cover it;
 * - `global`: factory-wide (keys, settings, audit, new projects), the key must cover every project;
 * - `list`: lists across projects, results are filtered to the key's projects by the caller.
 */
export type OpScope =
  | { kind: "project"; projectId: string }
  | { kind: "global" }
  | { kind: "list" };

export function allows(scope: KeyScope, action: Action, target: OpScope): boolean {
  if (!hasAction(scope, action)) return false;
  switch (target.kind) {
    case "global":
      return scope.projects === "*";
    case "list":
      return true;
    case "project":
      return scope.projects === "*" || scope.projects.includes(target.projectId);
  }
}

export interface KeyLimits {
  scope: KeyScope;
  budget: KeyBudget;
  ratePerMinute: number;
}

/** A key may only mint keys whose scope, budget and rate limit are no wider than its own. */
export function withinLimits(parent: KeyLimits, child: KeyLimits): string | null {
  if (parent.scope.projects !== "*") {
    if (child.scope.projects === "*") return "cannot grant access to all projects";
    const outside = child.scope.projects.filter((p) => !parent.scope.projects.includes(p));
    if (outside.length > 0)
      return `cannot grant projects outside your scope: ${outside.join(", ")}`;
  }
  if (!parent.scope.actions.includes("admin")) {
    const extra = child.scope.actions.filter((a) => !parent.scope.actions.includes(a));
    if (extra.length > 0) return `cannot grant actions you don't have: ${extra.join(", ")}`;
  }
  for (const field of ["runsPerDay", "mutationsPerDay"] as const) {
    const cap = parent.budget[field];
    const requested = child.budget[field];
    if (cap !== undefined && (requested === undefined || requested > cap)) {
      return `${field} must be set and at most ${cap}`;
    }
  }
  if (child.ratePerMinute > parent.ratePerMinute) {
    return `ratePerMinute must be at most ${parent.ratePerMinute}`;
  }
  return null;
}

/** Keys are random 256-bit secrets, so a plain SHA-256 at rest is enough; only the hash is stored. */
export class KeyStore {
  private readonly keys = new Map<string, ApiKeyRecord>();

  private readonly state: PrivateState<ApiKeyRecord[]>;

  constructor(
    file?: string,
    readonly stateOwner?: PrivateStateOwner,
  ) {
    if (file && !stateOwner) throw new Error("durable keys require exclusive lifetime ownership");
    if (file) stateOwner?.claimStore(file);
    this.state = new PrivateState(file, stateOwner);
    for (const record of this.state.load([])) this.keys.set(record.id, record);
  }

  private persist(): void {
    this.stateOwner?.assertOwned();
    this.state.save([...this.keys.values()]);
  }

  private readonly revokeListeners = new Set<(id: string) => void>();

  create(input: {
    name: string;
    scope: KeyScope;
    kind?: KeyKind;
    budget?: KeyBudget;
    ratePerMinute?: number;
    createdByKeyId?: string;
  }): {
    token: string;
    key: PublicKey;
  } {
    this.stateOwner?.assertOwned();
    const id = randomBytes(9)
      .toString("base64url")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "0")
      .slice(0, 12);
    const secret = randomBytes(32).toString("base64url");
    const record: ApiKeyRecord = {
      id,
      name: input.name,
      kind: KeyKindSchema.parse(input.kind ?? "agent"),
      hash: hashSecret(secret).toString("hex"),
      scope: KeyScopeSchema.parse(input.scope),
      budget: KeyBudgetSchema.parse(input.budget ?? {}),
      ratePerMinute: input.ratePerMinute ?? 120,
      createdAt: new Date().toISOString(),
      ...(input.createdByKeyId ? { createdByKeyId: input.createdByKeyId } : {}),
    };
    this.keys.set(id, record);
    this.persist();
    return { token: `mx_${id}_${secret}`, key: toPublic(record) };
  }

  /** Registers a key whose secret is held elsewhere (e.g. bootstrap admin key from the environment). */
  importHashed(record: ApiKeyRecord): void {
    this.stateOwner?.assertOwned();
    if (this.keys.has(record.id)) return;
    this.keys.set(record.id, record);
    this.persist();
  }

  verify(token: string): ApiKeyRecord | null {
    this.stateOwner?.assertOwned();
    const match = TOKEN_RE.exec(token);
    if (!match) return null;
    const [, id, secret] = match;
    const record = this.keys.get(id ?? "");
    if (!record || record.revokedAt || !secret) return null;
    const expected = Buffer.from(record.hash, "hex");
    const actual = hashSecret(secret);
    return expected.length === actual.length && timingSafeEqual(expected, actual) ? record : null;
  }

  list(): PublicKey[] {
    this.stateOwner?.assertOwned();
    return [...this.keys.values()].map(toPublic);
  }

  revoke(id: string): boolean {
    this.stateOwner?.assertOwned();
    const record = this.keys.get(id);
    if (!record || record.revokedAt) return false;
    record.revokedAt = new Date().toISOString();
    this.persist();
    for (const listener of this.revokeListeners) listener(id);
    return true;
  }

  get(id: string): ApiKeyRecord | null {
    this.stateOwner?.assertOwned();
    return this.keys.get(id) ?? null;
  }

  update(
    id: string,
    patch: { name?: string; budget?: KeyBudget; ratePerMinute?: number },
  ): PublicKey | null {
    this.stateOwner?.assertOwned();
    const record = this.keys.get(id);
    if (!record || record.revokedAt) return null;
    if (patch.name !== undefined) record.name = patch.name;
    if (patch.budget !== undefined) record.budget = KeyBudgetSchema.parse(patch.budget);
    if (patch.ratePerMinute !== undefined) record.ratePerMinute = patch.ratePerMinute;
    this.persist();
    return toPublic(record);
  }

  isActive(id: string): boolean {
    this.stateOwner?.assertOwned();
    const record = this.keys.get(id);
    return Boolean(record && !record.revokedAt);
  }

  /** Notifies long-lived connections (SSE) so they close as soon as their key is revoked. */
  onRevoke(listener: (id: string) => void): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }
}

export function hashToken(token: string): { id: string; hash: string } | null {
  const match = TOKEN_RE.exec(token);
  if (!match?.[1] || !match[2]) return null;
  return { id: match[1], hash: hashSecret(match[2]).toString("hex") };
}

import { PrivateState } from "../private-state.js";
