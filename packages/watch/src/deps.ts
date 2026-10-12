import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Dependency } from "./types.js";

async function read(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

const LOCAL = /^(workspace:|file:|link:|portal:|git\+|github:)/;

async function workspaceDirs(root: string, patterns: string[]): Promise<string[]> {
  const dirs: string[] = [];
  for (const pattern of patterns) {
    if (pattern.endsWith("/*")) {
      const base = join(root, pattern.slice(0, -2));
      try {
        for (const entry of await readdir(base, { withFileTypes: true })) {
          if (entry.isDirectory()) dirs.push(join(base, entry.name));
        }
      } catch {}
    } else if (!pattern.includes("*")) {
      dirs.push(join(root, pattern));
    }
  }
  return dirs.sort();
}

/** Tolerant parse of bun.lock (JSON with trailing commas) and package-lock.json into name → version. */
export function parseLock(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let data: { packages?: Record<string, unknown> };
  try {
    data = JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return out;
  }
  for (const [key, value] of Object.entries(data.packages ?? {})) {
    if (Array.isArray(value) && typeof value[0] === "string") {
      const spec = value[0];
      const at = spec.lastIndexOf("@");
      if (at > 0) out.set(spec.slice(0, at), spec.slice(at + 1));
    } else if (
      value &&
      typeof value === "object" &&
      "version" in value &&
      key.startsWith("node_modules/")
    ) {
      out.set(
        key.slice("node_modules/".length).replace(/^.*node_modules\//, ""),
        String((value as { version: string }).version),
      );
    }
  }
  return out;
}

export function parseCargo(text: string): Dependency[] {
  const out: Dependency[] = [];
  let inDeps = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inDeps = /^\[(dev-|build-)?dependencies\]$/.test(line);
      continue;
    }
    if (!inDeps || !line || line.startsWith("#")) continue;
    const m = /^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]+)"|\{.*?version\s*=\s*"([^"]+)".*\})/.exec(line);
    if (m) out.push({ ecosystem: "crates", name: m[1]!, version: m[2] ?? m[3] ?? "*" });
  }
  return out;
}

export function parsePython(requirements: string | null, pyproject: string | null): Dependency[] {
  const lines: string[] = [];
  if (requirements) lines.push(...requirements.split("\n"));
  const block = pyproject ? /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(pyproject)?.[1] : undefined;
  if (block) lines.push(...[...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!));
  const out: Dependency[] = [];
  for (const raw of lines) {
    const line = raw.split("#")[0]!.trim();
    const m = /^([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*([<>=!~].*)?$/.exec(line);
    if (m && !line.startsWith("-"))
      out.push({ ecosystem: "pypi", name: m[1]!.toLowerCase(), version: m[2]?.trim() ?? "*" });
  }
  return out;
}

/** Reads every manifest the project declares (npm workspaces, Cargo, Python). Sorted and deduplicated. */
export async function readDependencies(root: string): Promise<Dependency[]> {
  const deps = new Map<string, Dependency>();
  const add = (d: Dependency) => {
    const key = `${d.ecosystem}:${d.name}`;
    if (!deps.has(key)) deps.set(key, d);
  };

  const rootPkg = await read(join(root, "package.json"));
  if (rootPkg) {
    const pkg = JSON.parse(rootPkg) as { workspaces?: string[] | { packages?: string[] } };
    const patterns = Array.isArray(pkg.workspaces)
      ? pkg.workspaces
      : (pkg.workspaces?.packages ?? []);
    const lock = parseLock(
      (await read(join(root, "bun.lock"))) ?? (await read(join(root, "package-lock.json"))) ?? "",
    );
    for (const dir of [root, ...(await workspaceDirs(root, patterns))]) {
      const text = await read(join(dir, "package.json"));
      if (!text) continue;
      const p = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
      for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
        for (const [name, version] of Object.entries(p[field] ?? {})) {
          if (LOCAL.test(version)) continue;
          const resolved = lock.get(name);
          add({ ecosystem: "npm", name, version, ...(resolved ? { resolved } : {}) });
        }
      }
    }
  }
  const cargo = await read(join(root, "Cargo.toml"));
  if (cargo) parseCargo(cargo).forEach(add);
  parsePython(
    await read(join(root, "requirements.txt")),
    await read(join(root, "pyproject.toml")),
  ).forEach(add);
  return [...deps.values()].sort((a, b) =>
    `${a.ecosystem}:${a.name}`.localeCompare(`${b.ecosystem}:${b.name}`),
  );
}
