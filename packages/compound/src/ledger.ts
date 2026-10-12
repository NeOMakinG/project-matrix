import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { ReplayCase } from "./evaluate.js";
import { canonical } from "./hash.js";
import { isInsideReal, readFileSafe, safeJoin, writeFileSafe } from "./paths.js";
import { CandidateIdSchema, type Evaluation, EvaluationSchema, PhaseSchema } from "./types.js";

export const PromotionSchema = z.object({
  candidateId: CandidateIdSchema,
  candidateHash: z.string().regex(/^[0-9a-f]{64}$/),
  evaluationId: z.string(),
  caseSetHash: z.string(),
  harnessVersion: z.string(),
  at: z.string(),
});
export type Promotion = z.infer<typeof PromotionSchema>;

export const ApprovalSchema = z.object({
  candidateId: CandidateIdSchema,
  candidateHash: z.string().regex(/^[0-9a-f]{64}$/),
  by: z.string().min(1),
  note: z.string().optional(),
  at: z.string(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const ReplayCaseSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/),
  ticketId: z.string().min(1),
  phase: PhaseSchema,
  input: z.string().min(1),
  expectedP1: z.array(z.string()),
});

const PROJECT_ID = /^[A-Za-z0-9._-]{1,80}$/;

/**
 * Where evaluation verdicts, promotions, approvals and the authoritative replay-case history live. It
 * must be owned by the host, never by the repository agents edit.
 */
export interface EvalLedger {
  recordEvaluation(evaluation: Evaluation): Promise<void>;
  getEvaluation(candidateId: string, evaluationId: string): Promise<Evaluation | null>;
  listEvaluations(candidateId: string): Promise<Evaluation[]>;
  recordPromotion(promotion: Promotion): Promise<void>;
  getPromotion(candidateId: string, candidateHash: string): Promise<Promotion | null>;
  recordApproval(approval: Approval): Promise<void>;
  getApproval(candidateId: string, candidateHash: string): Promise<Approval | null>;
  /** Adds past cases to the project's replay history (dedup by id). Only the host calls this. */
  recordCaseHistory(projectId: string, cases: ReplayCase[]): Promise<void>;
  caseHistory(projectId: string): Promise<ReplayCase[]>;
}

export class LedgerError extends Error {}

/** Loads the host-held HMAC key, creating a random 32-byte key (mode 0600) on first use. */
export async function loadOrCreateLedgerKey(path: string): Promise<Buffer> {
  const base = dirname(path);
  const existing = await readFileSafe(base, path);
  if (existing) {
    const key = Buffer.from(existing.trim(), "hex");
    if (key.length !== 32) throw new LedgerError(`${path} is not a 32-byte hex key`);
    return key;
  }
  const key = randomBytes(32);
  await writeFileSafe(base, path, `${key.toString("hex")}\n`, { mode: 0o600 });
  return key;
}

/**
 * File ledger in a host-owned directory. Records are sealed with an HMAC under a host-held key, so a
 * process that can write ledger files but not read the key cannot forge them. Placement is checked on
 * real paths, so a symlinked ancestor pointing into a repo is refused.
 */
export class FileEvalLedger implements EvalLedger {
  private constructor(
    private readonly dir: string,
    private readonly key: Buffer,
  ) {}

  static async open(dir: string, forbiddenRoots: string[], key: Buffer): Promise<FileEvalLedger> {
    if (key.length < 32) throw new LedgerError("ledger key must be at least 32 bytes");
    for (const root of forbiddenRoots) {
      if (await isInsideReal(root, dir))
        throw new LedgerError(`ledger ${dir} must not be inside ${root}`);
      if (await isInsideReal(dir, root))
        throw new LedgerError(`ledger ${dir} must not contain ${root}`);
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if ((await lstat(dir)).isSymbolicLink()) throw new LedgerError(`ledger ${dir} is a symlink`);
    return new FileEvalLedger(dir, key);
  }

  private mac(record: unknown): string {
    return createHmac("sha256", this.key).update(canonical(record)).digest("hex");
  }

  private async write(parts: string[], record: unknown) {
    const body = { record, mac: this.mac(record) };
    await writeFileSafe(
      this.dir,
      safeJoin(this.dir, ...parts),
      `${JSON.stringify(body, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  private async read<T>(parts: string[], schema: z.ZodType<T>): Promise<T | null> {
    const path = safeJoin(this.dir, ...parts);
    const raw = await readFileSafe(this.dir, path);
    if (raw === null) return null;
    const { record, mac } = JSON.parse(raw) as { record: unknown; mac?: string };
    const expected = Buffer.from(this.mac(record), "hex");
    const actual = Buffer.from(typeof mac === "string" ? mac : "", "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new LedgerError(`${path} is not sealed by this ledger`);
    }
    return schema.parse(record);
  }

  async recordEvaluation(e: Evaluation) {
    await this.write(
      ["evaluations", CandidateIdSchema.parse(e.candidateId), `${e.id}.json`],
      EvaluationSchema.parse(e),
    );
  }
  async getEvaluation(candidateId: string, evaluationId: string) {
    if (!/^eval-[0-9a-f]{16}$/.test(evaluationId)) return null;
    return this.read(
      ["evaluations", CandidateIdSchema.parse(candidateId), `${evaluationId}.json`],
      EvaluationSchema,
    );
  }
  async listEvaluations(candidateId: string) {
    const id = CandidateIdSchema.parse(candidateId);
    let names: string[] = [];
    try {
      names = (await readdir(safeJoin(this.dir, "evaluations", id))).filter((n) =>
        /^eval-[0-9a-f]{16}\.json$/.test(n),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const list = await Promise.all(
      names.map((n) => this.getEvaluation(id, n.replace(/\.json$/, ""))),
    );
    return list
      .filter((e): e is Evaluation => e !== null)
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }
  async recordPromotion(p: Promotion) {
    const v = PromotionSchema.parse(p);
    await this.write(["promotions", v.candidateId, `${v.candidateHash}.json`], v);
  }
  async getPromotion(candidateId: string, candidateHash: string) {
    if (!/^[0-9a-f]{64}$/.test(candidateHash)) return null;
    return this.read(
      ["promotions", CandidateIdSchema.parse(candidateId), `${candidateHash}.json`],
      PromotionSchema,
    );
  }
  async recordApproval(a: Approval) {
    const v = ApprovalSchema.parse(a);
    await this.write(["approvals", v.candidateId, `${v.candidateHash}.json`], v);
  }
  async getApproval(candidateId: string, candidateHash: string) {
    if (!/^[0-9a-f]{64}$/.test(candidateHash)) return null;
    return this.read(
      ["approvals", CandidateIdSchema.parse(candidateId), `${candidateHash}.json`],
      ApprovalSchema,
    );
  }
  async recordCaseHistory(projectId: string, cases: ReplayCase[]) {
    if (!PROJECT_ID.test(projectId)) throw new LedgerError(`invalid project id ${projectId}`);
    const merged = new Map((await this.caseHistory(projectId)).map((c) => [c.id, c]));
    for (const c of z.array(ReplayCaseSchema).parse(cases))
      if (!merged.has(c.id)) merged.set(c.id, c);
    const list = [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
    await this.write(["cases", `${projectId}.json`], list);
  }
  async caseHistory(projectId: string) {
    if (!PROJECT_ID.test(projectId)) throw new LedgerError(`invalid project id ${projectId}`);
    return (await this.read(["cases", `${projectId}.json`], z.array(ReplayCaseSchema))) ?? [];
  }
}
