import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { PrivateStateOwner } from "../state-owner.js";

export function publishOwnedFile(input: {
  root: string;
  path: string;
  content: string;
  previous?: string | undefined;
  replace?: boolean;
  createOnly?: boolean;
  requireExisting?: boolean;
  mode?: number;
  owner?: PrivateStateOwner | undefined;
}): void {
  const check = () => input.owner?.assertOwned();
  check();
  const root = resolve(input.root);
  const target = resolve(input.path);
  const path = relative(root, target);
  if (!path || path.startsWith("..") || isAbsolute(path))
    throw new Error("generated path outside project root");
  let current = root;
  for (const component of ["", ...relative(root, dirname(target)).split(sep).filter(Boolean)]) {
    if (component) current = resolve(current, component);
    check();
    try {
      const entry = lstatSync(current);
      if (entry.isSymbolicLink() || !entry.isDirectory())
        throw new Error("generated parent must be a real directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      check();
      mkdirSync(current, { mode: 0o700 });
    }
  }
  let exists = false;
  let previous: string | undefined;
  let mode = input.mode ?? 0o644;
  try {
    const entry = lstatSync(target);
    if (entry.isSymbolicLink() || !entry.isFile())
      throw new Error("generated target must be a regular file");
    if (input.createOnly)
      throw Object.assign(new Error("generated target already exists"), { code: "EEXIST" });
    const existing = readFileSync(target, "utf8");
    if (input.requireExisting && input.previous !== undefined && existing !== input.previous)
      throw new Error("generated target changed; refusing to overwrite");
    if (existing === input.content) return;
    if (!input.replace && existing !== input.previous)
      throw new Error("generated target changed; refusing to overwrite");
    exists = true;
    previous = existing;
    mode = input.mode ?? entry.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (input.requireExisting) throw error;
  }
  check();
  const temporary = `${target}.${randomUUID()}.tmp`;
  const descriptor = openSync(
    temporary,
    constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_CREAT | constants.O_EXCL,
    mode,
  );
  try {
    try {
      check();
      writeFileSync(descriptor, input.content);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    check();
    if (exists) {
      const entry = lstatSync(target);
      if (!entry.isFile() || entry.isSymbolicLink() || readFileSync(target, "utf8") !== previous)
        throw new Error("generated target changed; refusing to overwrite");
      check();
      renameSync(temporary, target);
    } else {
      check();
      linkSync(temporary, target);
    }
    const directory = openSync(dirname(target), constants.O_RDONLY);
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
