import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { canonical, sha256 } from "./hash.js";
import { assertNoSymlink, isInside, safeJoin } from "./paths.js";
import { CandidateIdSchema, type Evaluation, EvaluationSchema } from "./types.js";

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

/**
 * Where evaluation verdicts, promotions and approvals live. It must be owned by the host (or the core
 * store), never by the repository the agents edit; otherwise an agent could write its own verdict.
 */
export interface EvalLedger {
  recordEvaluation(evaluation: Evaluation): Promise<void>;
  getEvaluation(candidateId: string, evaluationId: string): Promise<Evaluation | null>;
  listEvaluations(candidateId: string): Promise<Evaluation[]>;
  recordPromotion(promotion: Promotion): Promise<void>;
  getPromotion(candidateId: string, candidateHash: string): Promise<Promotion | null>;
  recordApproval(approval: Approval): Promise<void>;
  getApproval(candidateId: string, candidateHash: string): Promise<Approval | null>;
}

export class LedgerError extends Error {}

const sealed = <T>(record: T) => ({ record, digest: sha256(canonical(record)) });

/** File ledger in a host-owned directory. Refuses to live inside any of `forbiddenRoots` (the repos). */
export class FileEvalLedger implements EvalLedger {
  constructor(
    private readonly dir: string,
    forbiddenRoots: string[],
  ) {
    for (const root of forbiddenRoots) {
      if (isInside(root, dir)) throw new LedgerError(`ledger ${dir} must not be inside ${root}`);
    }
  }

  private async write(parts: string[], record: unknown) {
    const path = safeJoin(this.dir, ...parts);
    await mkdir(join(path, ".."), { recursive: true });
    await assertNoSymlink(this.dir, path);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(sealed(record), null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
  }

  private async read<T>(parts: string[], schema: z.ZodType<T>): Promise<T | null> {
    const path = safeJoin(this.dir, ...parts);
    await assertNoSymlink(this.dir, path);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const { record, digest } = JSON.parse(raw) as { record: unknown; digest: string };
    if (sha256(canonical(record)) !== digest)
      throw new LedgerError(`${path} was modified outside the ledger`);
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
}
