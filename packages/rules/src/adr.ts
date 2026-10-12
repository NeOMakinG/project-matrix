import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { toPosix } from "@matrix/graph";
import { type AdrRule, adrRulesBlockSchema } from "./schema";

export const DEFAULT_ADR_DIR = "docs/adr";

export interface AdrRuleIssue {
  line: number;
  message: string;
}

export interface Adr {
  /** Four-digit number from the file name, e.g. `0023`. */
  number: string;
  /** Display reference, e.g. `ADR-0023`. */
  ref: string;
  /** Product-graph node id, e.g. `adr:0023`. */
  nodeId: string;
  title: string;
  status?: string;
  file: string;
  rules: { rule: AdrRule; line: number }[];
  /** Malformed `matrix-rules` blocks. */
  issues: AdrRuleIssue[];
}

const FILE_RE = /^(\d{4})-[\w.-]+\.md$/;

/** Parses one ADR markdown file. `file` is the repo-relative path used in reports. */
export function parseAdr(file: string, text: string): Adr | undefined {
  const name = file.split("/").pop() ?? file;
  const number = FILE_RE.exec(name)?.[1];
  if (!number) return undefined;
  const lines = text.split("\n");
  const heading = lines.find((l) => l.startsWith("# "));
  const title = (heading ?? `# ${name}`)
    .slice(2)
    .replace(/^\d+\.\s*/, "")
    .trim();
  const status = lines
    .map((l) => /^[-*]?\s*status:\s*(.+)$/i.exec(l.trim())?.[1])
    .find((s) => s !== undefined)
    ?.trim();

  const rules: Adr["rules"] = [];
  const issues: AdrRuleIssue[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.trim() !== "```matrix-rules") continue;
    const first = i + 1;
    /** 1-based line of the block's first JSON line, used in reports. */
    const start = i + 2;
    const end = lines.findIndex((l, j) => j > i && l.trim() === "```");
    if (end === -1) {
      issues.push({ line: start, message: "unterminated matrix-rules block" });
      break;
    }
    i = end;
    let json: unknown;
    try {
      json = JSON.parse(lines.slice(first, end).join("\n"));
    } catch (e) {
      issues.push({ line: start, message: `invalid JSON: ${(e as Error).message}` });
      continue;
    }
    const parsed = adrRulesBlockSchema.safeParse(json);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        issues.push({ line: start, message: `${issue.path.join(".")}: ${issue.message}` });
      continue;
    }
    for (const rule of parsed.data) rules.push({ rule, line: start });
  }

  return {
    number,
    ref: `ADR-${number}`,
    nodeId: `adr:${number}`,
    title,
    ...(status ? { status } : {}),
    file,
    rules,
    issues,
  };
}

/** Loads every `NNNN-*.md` ADR from the project's ADR folder, sorted by number. */
export async function loadAdrs(root: string, adrDir = DEFAULT_ADR_DIR): Promise<Adr[]> {
  const dir = join(root, adrDir);
  const names = await readdir(dir).catch(() => [] as string[]);
  const adrs: Adr[] = [];
  for (const name of names.sort()) {
    if (!FILE_RE.test(name)) continue;
    const adr = parseAdr(toPosix(join(adrDir, name)), await readFile(join(dir, name), "utf8"));
    if (adr) adrs.push(adr);
  }
  return adrs;
}

/** Superseded or rejected ADRs no longer bind code. */
export const isActive = (adr: Adr) => !/^(superseded|deprecated|rejected)/i.test(adr.status ?? "");
