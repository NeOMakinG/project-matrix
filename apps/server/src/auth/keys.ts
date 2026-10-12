import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

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

export interface ApiKeyRecord {
  id: string;
  name: string;
  hash: string;
  scope: KeyScope;
  budget: KeyBudget;
  ratePerMinute: number;
  createdAt: string;
  revokedAt?: string;
}

export type PublicKey = Omit<ApiKeyRecord, "hash">;

const TOKEN_RE = /^mx_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;

const hashSecret = (secret: string) => createHash("sha256").update(secret).digest();

export function toPublic(record: ApiKeyRecord): PublicKey {
  const { hash: _hash, ...rest } = record;
  return rest;
}

export function allows(scope: KeyScope, action: Action, projectId?: string): boolean {
  const actionOk = scope.actions.includes("admin") || scope.actions.includes(action);
  if (!actionOk) return false;
  if (projectId === undefined || scope.projects === "*") return true;
  return scope.projects.includes(projectId);
}

/** Keys are random 256-bit secrets, so a plain SHA-256 at rest is enough; only the hash is stored. */
export class KeyStore {
  private readonly keys = new Map<string, ApiKeyRecord>();

  create(input: { name: string; scope: KeyScope; budget?: KeyBudget; ratePerMinute?: number }): {
    token: string;
    key: PublicKey;
  } {
    const id = randomBytes(9)
      .toString("base64url")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "0")
      .slice(0, 12);
    const secret = randomBytes(32).toString("base64url");
    const record: ApiKeyRecord = {
      id,
      name: input.name,
      hash: hashSecret(secret).toString("hex"),
      scope: KeyScopeSchema.parse(input.scope),
      budget: KeyBudgetSchema.parse(input.budget ?? {}),
      ratePerMinute: input.ratePerMinute ?? 120,
      createdAt: new Date().toISOString(),
    };
    this.keys.set(id, record);
    return { token: `mx_${id}_${secret}`, key: toPublic(record) };
  }

  /** Registers a key whose secret is held elsewhere (e.g. bootstrap admin key from the environment). */
  importHashed(record: ApiKeyRecord): void {
    this.keys.set(record.id, record);
  }

  verify(token: string): ApiKeyRecord | null {
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
    return [...this.keys.values()].map(toPublic);
  }

  revoke(id: string): boolean {
    const record = this.keys.get(id);
    if (!record || record.revokedAt) return false;
    record.revokedAt = new Date().toISOString();
    return true;
  }
}

export function hashToken(token: string): { id: string; hash: string } | null {
  const match = TOKEN_RE.exec(token);
  if (!match?.[1] || !match[2]) return null;
  return { id: match[1], hash: hashSecret(match[2]).toString("hex") };
}
