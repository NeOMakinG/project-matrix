import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Where a real credential comes from. It is read on the host and never handed to a sandbox. */
export type CredentialSource =
  | { env: string }
  | { file: string; pattern?: RegExp }
  | { command: string[] }
  | { value: string };

/**
 * Applies a key-file pattern one line at a time (first matching line wins), so a pattern like
 * `^ *api_key: *([^ ]+)` can never run past the end of the key line and glue the next line on.
 */
export function matchKeyLine(text: string, pattern: RegExp): string | undefined {
  const line = new RegExp(pattern.source, pattern.flags.replace(/[gmsy]/g, ""));
  for (const raw of text.split(/\r?\n/)) {
    const match = line.exec(raw);
    // With a capture group, only the group counts (never the whole `api_key:` line).
    const value = (match && match.length > 1 ? match[1] : match?.[0])?.trim();
    if (value) return value;
  }
  return undefined;
}

export async function resolveCredential(source: CredentialSource): Promise<string> {
  let value: string | undefined;
  if ("value" in source) value = source.value;
  else if ("env" in source) value = process.env[source.env];
  else if ("file" in source) {
    const text = await readFile(source.file, "utf8");
    value = source.pattern ? matchKeyLine(text, source.pattern) : text;
  } else {
    const [command, ...args] = source.command;
    if (!command) throw new Error("empty credential command");
    const { stdout } = await execFileAsync(command, args, { timeout: 15_000 });
    value = stdout;
  }
  const trimmed = value?.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) throw new Error("credential source resolved to an empty value");
  return trimmed;
}
