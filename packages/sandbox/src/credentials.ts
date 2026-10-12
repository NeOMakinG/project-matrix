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

export async function resolveCredential(source: CredentialSource): Promise<string> {
  let value: string | undefined;
  if ("value" in source) value = source.value;
  else if ("env" in source) value = process.env[source.env];
  else if ("file" in source) {
    const text = await readFile(source.file, "utf8");
    if (source.pattern) {
      const match = source.pattern.exec(text);
      value = match?.[1] ?? match?.[0];
    } else value = text;
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
