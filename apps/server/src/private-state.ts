import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { PrivateStateOwner } from "./state-owner.js";

export function preparePrivateFile(path?: string): string | undefined {
  if (!path) return undefined;
  const file = resolve(path);
  const parent = dirname(file);
  let current: string = sep;
  for (const component of parent.split(sep).filter(Boolean)) {
    current = resolve(current, component);
    if (process.platform === "darwin" && ["/var", "/tmp", "/etc"].includes(current))
      current = realpathSync(current);
    try {
      const entry = lstatSync(current);
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error("private state parent must be a real directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
    }
  }
  try {
    const entry = lstatSync(file);
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0)
      throw new Error("private state must be a regular file with mode 600");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return file;
}

export class PrivateState<T> {
  constructor(
    private readonly file?: string,
    private readonly owner?: PrivateStateOwner,
  ) {}

  private prepare(): string | undefined {
    if (this.file) this.owner?.assertFile(this.file);
    return preparePrivateFile(this.file);
  }

  load(fallback: T): T {
    const file = this.prepare();
    if (!file) return fallback;
    let descriptor: number;
    try {
      descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw error;
    }
    try {
      return JSON.parse(readFileSync(descriptor, "utf8")) as T;
    } finally {
      closeSync(descriptor);
    }
  }

  save(value: T): void {
    const file = this.prepare();
    if (!file) return;
    const temporary = `${file}.${randomUUID()}.tmp`;
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      this.owner?.assertOwned();
      writeFileSync(descriptor, JSON.stringify(value));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      this.owner?.assertOwned();
      renameSync(temporary, file);
      const directory = openSync(dirname(file), constants.O_RDONLY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } finally {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}
