import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Store } from "@matrix/core";
import { patchHash } from "./hash.js";
import { readFileSafe, safeJoin, writeFileSafe } from "./paths.js";
import type { Proposal } from "./propose.js";
import {
  CANDIDATE_ID,
  type Candidate,
  CandidatePayloadSchema,
  CandidateSchema,
  type CandidateStatus,
  type RawLesson,
} from "./types.js";

export function candidateId(projectId: string, proposal: Pick<Proposal, "payload">): string {
  const payload = CandidatePayloadSchema.parse(proposal.payload);
  return `${payload.kind}-${patchHash(projectId, payload.kind, payload).slice(0, 12)}`;
}

const lessonKey = (l: RawLesson) => `${l.ticketId}\u0000${l.source}\u0000${l.text}`;

/**
 * Candidate proposals under `<root>/.matrix/lessons/`. These files are editable by anyone with repo
 * access, so they carry no authority: promotion and approval live in the host-owned EvalLedger.
 */
export class LessonStore {
  readonly dir: string;
  constructor(
    private readonly root: string,
    private readonly index?: Store,
    private readonly now: () => Date = () => new Date(),
    private readonly publish: (
      root: string,
      path: string,
      content: string,
    ) => Promise<void> = writeFileSafe,
  ) {
    this.dir = join(root, ".matrix", "lessons");
  }

  private path(id: string) {
    if (!CANDIDATE_ID.test(id)) throw new Error(`invalid candidate id ${JSON.stringify(id)}`);
    return safeJoin(this.dir, `${id}.json`);
  }

  private async write(candidate: Candidate): Promise<Candidate> {
    const valid = CandidateSchema.parse(candidate);
    await this.publish(this.root, this.path(valid.id), `${JSON.stringify(valid, null, 2)}\n`);
    if (this.index) {
      await this.index.addLesson({
        projectId: valid.projectId,
        ticketId: valid.evidence[0]?.ticketId ?? "",
        source: `candidate:${valid.id}:v${valid.version}:${valid.status}`,
        lesson: valid.title,
      });
    }
    return valid;
  }

  async get(id: string): Promise<Candidate | null> {
    const raw = await readFileSafe(this.root, this.path(id));
    return raw === null ? null : CandidateSchema.parse(JSON.parse(raw));
  }

  async list(filter: { status?: CandidateStatus[] } = {}): Promise<Candidate[]> {
    let names: string[] = [];
    try {
      names = (await readdir(this.dir))
        .filter((n) => CANDIDATE_ID.test(n.replace(/\.json$/, "")) && n.endsWith(".json"))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const all = await Promise.all(names.map((n) => this.get(n.replace(/\.json$/, ""))));
    return all.filter(
      (c): c is Candidate => c !== null && (!filter.status || filter.status.includes(c.status)),
    );
  }

  /** Creates the candidate, or merges new evidence into it. */
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

  /** Mirrors a ledger decision into the file for readers. Never consulted for authorisation. */
  async mirrorStatus(id: string, status: CandidateStatus, note: string): Promise<Candidate> {
    const c = await this.get(id);
    if (!c) throw new Error(`unknown candidate ${id}`);
    const at = this.now().toISOString();
    return this.write({
      ...c,
      status,
      history: [...c.history, { at, version: c.version, status, note }],
      updatedAt: at,
    });
  }
}
