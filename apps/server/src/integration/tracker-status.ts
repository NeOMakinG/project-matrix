import type { WorkflowState } from "@matrix/core";
import { redact, singleLine } from "@matrix/monitor";

export interface StatusLink {
  label: string;
  url: string;
}

const SAFE_URL = /^https:\/\/[^\s()<>[\]`"']{1,500}$/;

/** Only plain https URLs make it into a tracker comment (no markdown/HTML breakout). */
export function safeLink(label: string, url: string | undefined): StatusLink | undefined {
  if (!url || !SAFE_URL.test(url)) return undefined;
  try {
    if (new URL(url).protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  return { label: singleLine(label, 40).replace(/[[\]`*_]/g, ""), url };
}

/** The Orca Run (and last dispatch) a ticket's agents run in; ids only. */
export interface OrcaStatusRef {
  run: string;
  dispatch?: string;
}

const ORCA_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** Reads `receipt.data.orca` defensively; anything that is not a plain id is dropped. */
export function orcaRef(data: unknown): OrcaStatusRef | undefined {
  const orca =
    typeof data === "object" && data !== null ? (data as { orca?: unknown }).orca : undefined;
  if (typeof orca !== "object" || orca === null) return undefined;
  const { run, dispatch } = orca as { run?: unknown; dispatch?: unknown };
  if (typeof run !== "string" || !ORCA_ID.test(run)) return undefined;
  return typeof dispatch === "string" && ORCA_ID.test(dispatch) ? { run, dispatch } : { run };
}

const code = (text: string) => `\`${text.replace(/`/g, "'")}\``;

/**
 * The live status comment body, without its timestamp: two renders with equal bodies mean
 * nothing worth an API call changed. Error text is redacted and single-lined.
 */
export function renderStatus(
  w: WorkflowState,
  links: readonly StatusLink[],
  orca?: OrcaStatusRef,
  pullRequest?: StatusLink,
): string {
  const lines = [
    `**Matrix** · phase ${code(w.phase)} · ${code(w.status)}`,
    `- Attempt ${w.attempt} · review loops ${w.loops}`,
  ];
  if (w.lastError) lines.push(`- Last error: ${code(singleLine(redact(w.lastError), 300))}`);
  if (orca)
    lines.push(
      `- Orca: Run ${code(orca.run)}${orca.dispatch ? ` · dispatch ${code(orca.dispatch)}` : ""} (open in Orca desktop/mobile)`,
    );
  if (pullRequest)
    lines.push(`- Draft PR: [${pullRequest.label}](${pullRequest.url}) (awaiting a human merge)`);
  if (links.length) lines.push(`- Links: ${links.map((l) => `[${l.label}](${l.url})`).join(", ")}`);
  return lines.join("\n");
}

export function withTimestamp(body: string, at: Date): string {
  return `${body}\n\n_Updated ${at.toISOString()}_`;
}
