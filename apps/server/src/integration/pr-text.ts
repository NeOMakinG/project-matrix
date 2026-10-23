import type { PullRequestEvidence } from "@matrix/core";
import { redact, singleLine } from "@matrix/monitor";
import { sanitizeUntrusted, type Ticket } from "@matrix/tickets";
import { safeLink } from "./tracker-status.js";

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/**
 * Untrusted text (ticket titles, run summaries) quoted into a GitHub PR: hidden and control
 * characters stripped, secrets redacted, and nothing that pings people or links issues:
 * `@` and `#<n>` become HTML entities, raw HTML is escaped.
 */
export function untrustedMarkdown(text: string, max: number): string {
  return (
    redact(sanitizeUntrusted(text))
      .replace(CONTROL, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      // `#<n>` first: the `@` entity itself contains `#64`.
      .replace(/#(?=\d)/g, "&#35;")
      .replace(/@/g, "&#64;")
      // No links, images or closing keywords ("fixes NEO-12", "closes https://.../issues/5").
      .replace(/[[\]!()]/g, (c) => `&#${c.charCodeAt(0)};`)
      .replace(
        /\b(clos|fix|resolv)(?=(e[sd]?|es|ed)?\b)/gi,
        (w) => `&#${w.charCodeAt(0)};${w.slice(1)}`,
      )
      .replace(/:\/\//g, "&#58;//")
      .slice(0, max)
      .trim()
  );
}

/** PR titles render no HTML: neutralize mentions and issue refs with look-alike characters. */
export function pullRequestTitle(ticket: Pick<Ticket, "id" | "title">): string {
  const title = singleLine(redact(sanitizeUntrusted(ticket.title)), 180)
    .replace(/@/g, "＠")
    .replace(/#(?=\d)/g, "＃");
  const id = ticket.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  return `${id}: ${title || "Matrix change"}`;
}

/** Lowercase ASCII slug of a ticket title, for branch names. */
export function slug(text: string, max = 40): string {
  return sanitizeUntrusted(text)
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

/**
 * Remote branch for a ticket: `matrix-<ticket>-<slug>`. Orca already turns `matrix/NEO-7` into
 * `matrix-NEO-7` locally, so the pushed name keeps the dash form plus a readable slug.
 */
export function pullRequestBranch(ticket: Pick<Ticket, "id" | "title">): string {
  const id =
    ticket.id
      .replace(/[^A-Za-z0-9_-]/g, "-")
      .replace(/^-+/, "")
      .slice(0, 40) || "ticket";
  const tail = slug(ticket.title);
  return tail ? `matrix-${id}-${tail}` : `matrix-${id}`;
}

export interface PullRequestBodyInput {
  ticket: Pick<Ticket, "id" | "title" | "url">;
  headSha: string;
  evidence: PullRequestEvidence[];
  /** Linear identifier line (`Linear: NEO-7`) when the tracker is Linear. */
  linear: boolean;
  /** Manual QA handoff: surfaces and the ticket's PUBLIC acceptance criteria (never holdout text). */
  manualQa?: { surfaces: string[]; criteria: string[] } | undefined;
}

const SURFACE = /^(host|api|web|android|ios)$/;

export function pullRequestBody(input: PullRequestBodyInput): string {
  const lines = [
    "## Summary",
    "",
    untrustedMarkdown(input.ticket.title, 300),
    "",
    input.manualQa
      ? `Validated head: \`${input.headSha.slice(0, 12)}\` (checks and review passed; QA needs a human, see below).`
      : `Validated head: \`${input.headSha.slice(0, 12)}\` (checks, review and QA passed).`,
  ];
  if (input.evidence.length) {
    lines.push("", "## Evidence", "");
    for (const item of input.evidence) {
      const links = item.urls
        .map((url, i) => safeLink(`${item.phase} ${i + 1}`, url))
        .filter((link) => link !== undefined)
        .map((link) => `[${link.label}](${link.url})`);
      const summary = untrustedMarkdown(singleLine(item.summary, 400), 400);
      lines.push(
        `- **${item.phase}**: ${summary || "passed"}${links.length ? ` (${links.join(", ")})` : ""}`,
      );
    }
  }
  if (input.manualQa) {
    const surfaces = input.manualQa.surfaces.filter((x) => SURFACE.test(x)).join("/") || "device";
    lines.push(
      "",
      "## Manual QA needed",
      "",
      `No ${surfaces} QA driver runs on the Matrix host. Test this branch on a device, tick each item, then merge and approve the merge in Matrix (or comment on the ticket and move it back to Ready).`,
      "",
    );
    const items = input.manualQa.criteria
      .slice(0, 30)
      .map((c) => untrustedMarkdown(singleLine(c, 300), 300))
      .filter(Boolean);
    if (items.length) for (const item of items) lines.push(`- [ ] ${item}`);
    else lines.push("- [ ] The ticket's acceptance criteria hold on the device");
  }
  if (input.linear) {
    const id = input.ticket.id.replace(/[^A-Za-z0-9_-]/g, "");
    const link = safeLink(id, input.ticket.url);
    lines.push("", link ? `Linear: [${id}](${link.url})` : `Linear: ${id}`);
  }
  lines.push(
    "",
    "---",
    "_Opened as a draft by [Project Matrix](https://github.com/NeOMakinG/project-matrix). Matrix never merges: review and merge it yourself._",
  );
  return lines.join("\n");
}
