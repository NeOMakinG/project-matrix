import { mkdir, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface TrustedWorktree {
  gitdir: string;
  commonDir: string;
}

/**
 * Host-side record of which gitdir each worktree belongs to, written at prepare time and kept
 * outside every worktree. Git ports read ONLY this; the worktree's `.git` is never a source of truth.
 */
export class TrustedWorktrees {
  readonly #path: string | undefined;
  #cache: Record<string, TrustedWorktree> | undefined;

  /** `path` persists the registry (host-owned, never mounted into a sandbox). Omit for in-memory. */
  constructor(path?: string) {
    this.#path = path;
  }

  async #load(): Promise<Record<string, TrustedWorktree>> {
    if (this.#cache) return this.#cache;
    if (!this.#path) return (this.#cache = {});
    try {
      this.#cache = JSON.parse(await readFile(this.#path, "utf8")) as Record<
        string,
        TrustedWorktree
      >;
    } catch {
      this.#cache = {};
    }
    return this.#cache;
  }

  async #save(): Promise<void> {
    if (!this.#path || !this.#cache) return;
    await mkdir(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.#cache, null, 2), { mode: 0o600 });
    await rename(tmp, this.#path);
  }

  async record(workdir: string, entry: TrustedWorktree): Promise<void> {
    (await this.#load())[workdir] = entry;
    await this.#save();
  }

  async lookup(workdir: string): Promise<TrustedWorktree> {
    const entry = (await this.#load())[workdir];
    if (!entry) throw new Error(`no trusted gitdir recorded for ${workdir}`);
    return entry;
  }

  async forget(workdir: string): Promise<void> {
    delete (await this.#load())[workdir];
    await this.#save();
  }
}

/**
 * Finds a worktree's gitdir from host-owned data only: the `gitdir` back-links git keeps under
 * `<commonDir>/worktrees/*`. The worktree's own `.git` file is not read.
 */
export async function gitdirFromCommonDir(commonDir: string, workdir: string): Promise<string> {
  const expected = join(await realpath(workdir), ".git");
  const base = join(commonDir, "worktrees");
  for (const name of await readdir(base).catch(() => [] as string[])) {
    const back = (await readFile(join(base, name, "gitdir"), "utf8").catch(() => "")).trim();
    if (
      back &&
      (back === expected || (await realpath(dirname(back)).catch(() => "")) === dirname(expected))
    ) {
      return join(base, name);
    }
  }
  throw new Error(`${workdir} is not a registered worktree of ${commonDir}`);
}
