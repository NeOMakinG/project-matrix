import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Store } from "@matrix/core";
import type { Proposal } from "./propose.js";
import {
  type Candidate,
  CandidateSchema,
  type CandidateStatus,
  type Evaluation,
  type RawLesson,
} from "./types.js";

export class PromotionError extends Error {}

export function candidateId(projectId: string, proposal: Pick<Proposal, "payload">): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([projectId, proposal.payload]))
    .digest("hex");
  return `${proposal.payload.kind}-${digest.slice(0, 12)}`;
}

const lessonKey = (l: RawLesson) => `${l.ticketId}\u0000${l.source}\u0000${l.text}`;

/**
 * Versioned candidate store. Files under `<root>/.matrix/lessons/` are the source of truth; the core
 * Store gets an index row per change so the dashboard can query without reading the repo.
 */
export class LessonStore {
  readonly dir: string;
  constructor(
    root: string,
    private readonly index?: Store,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.dir = join(root, ".matrix", "lessons");
  }

  private path(id: string) {
    return join(this.dir, `${id}.json`);
  }

  private async write(candidate: Candidate): Promise<Candidate> {
    const valid = CandidateSchema.parse(candidate);
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.path(valid.id)}.tmp`;
    await writeFile(tmp, `${JSON.stringify(valid, null, 2)}\n`);
    await rename(tmp, this.path(valid.id));
    if (this.index) {
      const first = valid.evidence[0];
      await this.index.addLesson({
        projectId: valid.projectId,
        ticketId: first?.ticketId ?? "",
        source: `candidate:${valid.id}:v${valid.version}:${valid.status}`,
        lesson: valid.title,
      });
    }
    return valid;
  }

  async get(id: string): Promise<Candidate | null> {
    try {
      return CandidateSchema.parse(JSON.parse(await readFile(this.path(id), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async list(filter: { status?: CandidateStatus[] } = {}): Promise<Candidate[]> {
    let names: string[] = [];
    try {
      names = (await readdir(this.dir)).filter((n) => n.endsWith(".json")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const all = await Promise.all(names.map((n) => this.get(n.replace(/\.json$/, ""))));
    return all.filter(
      (c): c is Candidate => c !== null && (!filter.status || filter.status.includes(c.status)),
    );
  }

  /** Creates the candidate, or merges new evidence into it (a version bump invalidates earlier evaluations for promotion). */
  async upsert(projectId: string, proposal: Proposal): Promise<Candidate> {
    const id = candidateId(projectId, proposal);
    const at = this.now().toISOString();
    const existing = await this.get(id);
    if (!existing) {
      return this.write({
        id,
        projectId,
        version: 1,
        status: "proposed",
        title: proposal.title,
        payload: proposal.payload,
        evidence: proposal.evidence,
        evaluations: [],
        history: [{ at, version: 1, status: "proposed", note: "proposed" }],
        createdAt: at,
        updatedAt: at,
      });
    }
    const known = new Set(existing.evidence.map(lessonKey));
    const fresh = proposal.evidence.filter((l) => !known.has(lessonKey(l)));
    if (!fresh.length) return existing;
    const version = existing.version + 1;
    return this.write({
      ...existing,
      version,
      evidence: [...existing.evidence, ...fresh],
      history: [
        ...existing.history,
        { at, version, status: existing.status, note: `+${fresh.length} evidence` },
      ],
      updatedAt: at,
    });
  }

  async recordEvaluation(id: string, evaluation: Evaluation): Promise<Candidate> {
    const c = await this.require(id);
    if (evaluation.candidateVersion !== c.version) {
      throw new PromotionError(
        `evaluation is for v${evaluation.candidateVersion}, candidate is v${c.version}`,
      );
    }
    return this.write({
      ...c,
      evaluations: [...c.evaluations, evaluation],
      updatedAt: evaluation.at,
    });
  }

  async setStatus(
    id: string,
    status: Exclude<CandidateStatus, "promoted">,
    note: string,
  ): Promise<Candidate> {
    const c = await this.require(id);
    const at = this.now().toISOString();
    return this.write({
      ...c,
      status,
      history: [...c.history, { at, version: c.version, status, note }],
      updatedAt: at,
    });
  }

  /** Promotion is only possible with a recorded `promote` evaluation of the current version. */
  async promote(id: string): Promise<Candidate> {
    const c = await this.require(id);
    const latest = c.evaluations.filter((e) => e.candidateVersion === c.version).at(-1);
    if (!latest) throw new PromotionError(`${id} v${c.version} has no recorded evaluation`);
    if (latest.decision !== "promote") {
      throw new PromotionError(
        `${id} latest evaluation decided ${latest.decision}: ${latest.reason}`,
      );
    }
    const at = this.now().toISOString();
    return this.write({
      ...c,
      status: "promoted",
      history: [
        ...c.history,
        { at, version: c.version, status: "promoted", note: `evaluation ${latest.id}` },
      ],
      updatedAt: at,
    });
  }

  private async require(id: string): Promise<Candidate> {
    const c = await this.get(id);
    if (!c) throw new Error(`unknown candidate ${id}`);
    return c;
  }
}
