/** Structural parsers for non-TypeScript rule checks (Go imports, Tauri capabilities). */

export interface GoImport {
  path: string;
  line: number;
}

/** Strips Go comments while keeping line numbers (strings and raw strings are preserved). */
function stripGoComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
    } else if (c === '"' || c === "`") {
      const q = c;
      out += c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (q === '"' && src[i] === "\\") {
          out += src[i] ?? "";
          i++;
        }
        out += src[i] ?? "";
        i++;
      }
      out += src[i] ?? "";
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const SPEC = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*|\.|_)?\s*("((?:[^"\\\n]|\\.)*)"|`([^`]*)`)/;

/** Every import path in a Go file: `import "x"`, `import a "x"`, raw strings and grouped blocks. */
export function parseGoImports(src: string): GoImport[] {
  const full = stripGoComments(src);
  // Go only allows imports before the first top-level declaration.
  const decl = /^(func|type|var|const)\b/m.exec(full);
  const text = decl ? full.slice(0, decl.index) : full;
  const out: GoImport[] = [];
  const lineAt = (idx: number) => text.slice(0, idx).split("\n").length;
  const re = /\bimport\b/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let i = m.index + m[0].length;
    while (/\s/.test(text[i] ?? "")) i++;
    if (text[i] === "(") {
      const end = text.indexOf(")", i);
      const body = text.slice(i + 1, end === -1 ? undefined : end);
      let offset = i + 1;
      for (const raw of body.split(/[\n;]/)) {
        const s = SPEC.exec(raw);
        if (s) out.push({ path: unquote(s[2], s[3]), line: lineAt(offset) });
        offset += raw.length + 1;
      }
      re.lastIndex = end === -1 ? text.length : end;
    } else {
      const s = SPEC.exec(text.slice(i, i + 4096));
      if (s) out.push({ path: unquote(s[2], s[3]), line: lineAt(i) });
    }
  }
  return out;
}

function unquote(interpreted: string | undefined, raw: string | undefined): string {
  if (raw !== undefined) return raw;
  try {
    return JSON.parse(`"${interpreted ?? ""}"`) as string;
  } catch {
    return interpreted ?? "";
  }
}

/** Go's standard generated-code marker within the file header. */
export const isGeneratedGo = (src: string): boolean =>
  /^\/\/ Code generated .* DO NOT EDIT\.$/m.test(src.split("\n").slice(0, 20).join("\n"));

export interface CapabilityFinding {
  message: string;
}

/** Permission families that hand the webview a shell or the whole filesystem. */
const DANGEROUS = [
  /^shell:.*(execute|spawn|open)/,
  /^shell:default$/,
  /^fs:default$/,
  /^fs:.*(-all|read-all|write-all|recursive)/,
  /^fs:(allow|scope)-(home|desktop|document|download|public|picture|video|audio)/,
  /^fs:(allow|scope)-(root|temp|localdata|data|config|cache|runtime|exe)(-|$)/,
  /^process:/,
];

const SAFE_SCOPE_ROOTS = /^\$(APPDATA|APPLOCALDATA|APPCONFIG|APPCACHE|APPLOG|RESOURCE)(\/|$)/;

/** Normalises a permission identifier the way Tauri resolves it (case, whitespace). */
export const normalizePermission = (id: string): string =>
  id.normalize("NFKC").trim().toLowerCase();

function scopeFindings(id: string, scope: unknown): CapabilityFinding[] {
  const entries = Array.isArray(scope) ? scope : [scope];
  const out: CapabilityFinding[] = [];
  for (const e of entries) {
    const path =
      typeof e === "string" ? e : typeof e === "object" && e && "path" in e ? String(e.path) : "";
    if (!path) {
      out.push({ message: `${id} scope cannot be verified: missing path` });
      continue;
    }
    const p = path.normalize("NFKC").trim();
    if (!SAFE_SCOPE_ROOTS.test(p) || p.includes("..") || p.includes("\\"))
      out.push({ message: `${id} scope "${path}" reaches outside the app's own directories` });
  }
  return out;
}

/** Checks one parsed capability object against the deny-list, allow-list and scope roots. */
export function checkCapabilityObject(cap: unknown, allow: string[]): CapabilityFinding[] {
  const allowed = new Set(allow.map(normalizePermission));
  const out: CapabilityFinding[] = [];
  const perms = (cap as { permissions?: unknown })?.permissions;
  if (!Array.isArray(perms)) return [{ message: "capability has no permissions array" }];
  for (const p of perms) {
    const rawId =
      typeof p === "string"
        ? p
        : typeof p === "object" && p && "identifier" in p
          ? String((p as { identifier: unknown }).identifier)
          : "";
    const id = normalizePermission(rawId);
    if (!id) {
      out.push({ message: "permission without an identifier" });
      continue;
    }
    if (DANGEROUS.some((re) => re.test(id)))
      out.push({ message: `${id} is a dangerous permission family` });
    else if (!allowed.has(id)) out.push({ message: `${id} is not on the ADR allow-list` });
    if (typeof p === "object" && p && "allow" in p)
      out.push(...scopeFindings(id, (p as { allow: unknown }).allow));
  }
  return out;
}

/** Capability files hold one capability, a list, or `{ capabilities: [...] }` (Tauri's three forms). */
export function capabilityObjects(doc: unknown): unknown[] {
  if (Array.isArray(doc)) return doc;
  if (
    doc &&
    typeof doc === "object" &&
    Array.isArray((doc as { capabilities?: unknown }).capabilities)
  )
    return (doc as { capabilities: unknown[] }).capabilities;
  return [doc];
}

/** Parses a JSON capability file and checks every capability in it. */
export function checkCapability(text: string, allow: string[]): CapabilityFinding[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [{ message: "capability file is not valid JSON, so it cannot be verified" }];
  }
  return capabilityObjects(doc).flatMap((c) => checkCapabilityObject(c, allow));
}
