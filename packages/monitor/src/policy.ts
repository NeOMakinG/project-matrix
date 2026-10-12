import type { TicketStore } from "@matrix/tickets";
import type { Issue } from "./group.js";
import type { Notifier } from "./ports.js";
import type { Severity, Triage } from "./triage.js";

export interface PolicyOptions {
  /** Minimum fixability for the factory to attempt an automatic fix. */
  fixableThreshold: number;
  /** Issues below this severity are recorded but get no ticket. */
  minSeverity: Severity;
  /** Severities that also notify humans when a ticket is created automatically. */
  notifyOn: Severity[];
}

export const defaultPolicy: PolicyOptions = {
  fixableThreshold: 0.6,
  minSeverity: "low",
  notifyOn: ["critical", "high"],
};

const RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const PRIORITY: Record<Severity, 0 | 1 | 2 | 3> = { critical: 0, high: 1, medium: 2, low: 3 };

export type Decision =
  | { action: "auto-fix"; ticketId: string }
  | { action: "human"; ticketId: string }
  | { action: "updated"; ticketId: string }
  | { action: "ignored"; reason: string };

export function ticketBody(issue: Issue, t: Triage): string {
  const a = t.assessment;
  const lines = [
    `Production issue \`${issue.fingerprint}\` (${t.severity}, fixability ${a.fixable.toFixed(2)}, ${a.category}).`,
    "",
    "## Evidence",
    `- Title: ${issue.title}`,
    issue.message ? `- Message: ${issue.message}` : "",
    `- Occurrences: ${t.impact.occurrences} (${t.impact.perHour}/h), users: ${t.impact.users}`,
    `- First seen ${issue.firstSeen}, last seen ${issue.lastSeen}`,
    `- Releases: ${Object.keys(issue.releases).join(", ") || "unknown"}`,
    `- Environments: ${issue.environments.join(", ") || "unknown"}`,
    `- Regression: ${t.regression.regression ? `yes (${t.regression.reason})` : "no"}`,
    ...issue.urls.map((u) => `- Link: ${u}`),
    "",
    "## Root cause (triage)",
    a.rootCause,
    "",
    a.rationale,
    "",
    "## Suspected files",
    ...(a.suspectedFiles.length > 0 ? a.suspectedFiles : t.hints.map((h) => h.path)).map(
      (f) => `- ${f}`,
    ),
    ...t.hints
      .filter((h) => h.adrs.length > 0 || h.features.length > 0)
      .map(
        (h) =>
          `  - ${h.path}: ADRs ${h.adrs.join(", ") || "-"}; features ${h.features.join(", ") || "-"}`,
      ),
    "",
    "## Reproduction",
    ...(a.reproSteps.length > 0
      ? a.reproSteps.map((s, i) => `${i + 1}. ${s}`)
      : ["Not determined."]),
    "",
    "## Stack (crash site first)",
    "```",
    ...issue.frames
      .slice(0, 12)
      .map(
        (f) =>
          `${f.inApp ? "" : "(lib) "}${f.file}${f.line !== undefined ? `:${f.line}` : ""} ${f.function ?? ""}`,
      ),
    "```",
    "",
    `Done when: the fix is deployed and the verify step shows no recurrence of \`${issue.fingerprint}\`.`,
    `Triage: ${t.model}, ${t.promptVersion} (${t.promptHash}).`,
  ];
  return lines.filter((l, i, all) => !(l === "" && all[i - 1] === "")).join("\n");
}

/** Turns a triaged issue into a ticket (auto-fix or human) or an update of its existing ticket. */
export async function applyPolicy(
  issue: Issue,
  t: Triage,
  deps: { tickets: TicketStore; notifier?: Notifier; options?: PolicyOptions },
): Promise<Decision> {
  const options = deps.options ?? defaultPolicy;
  if (issue.ticketId) {
    const reopen = issue.status === "reopened";
    await deps.tickets.comment(
      issue.ticketId,
      reopen
        ? `Recurred after the fix (${t.regression.reason}). ${t.impact.occurrences} occurrences so far.`
        : `Still occurring: ${t.impact.occurrences} occurrences, ${t.impact.users} users.`,
    );
    if (reopen) await deps.tickets.update(issue.ticketId, { status: "open" });
    return { action: "updated", ticketId: issue.ticketId };
  }
  if (RANK[t.severity] < RANK[options.minSeverity]) {
    return { action: "ignored", reason: `severity ${t.severity} below ${options.minSeverity}` };
  }

  const auto = t.assessment.fixable >= options.fixableThreshold && t.assessment.category === "code";
  const ticket = await deps.tickets.create({
    title: `[prod] ${issue.title}`.slice(0, 200),
    body: ticketBody(issue, t),
    labels: auto
      ? ["prod-fix", "auto-fix", `severity:${t.severity}`]
      : ["prod-fix", "needs-human", `severity:${t.severity}`],
    priority: PRIORITY[t.severity],
  });
  if (auto) await deps.tickets.update(ticket.id, { status: "ready" });

  if (deps.notifier && (!auto || options.notifyOn.includes(t.severity))) {
    const n: Parameters<Notifier["notify"]>[0] = {
      projectId: issue.projectId,
      severity: t.severity,
      title: `${auto ? "Auto-fixing" : "Needs a human"}: ${issue.title}`,
      body: `${t.assessment.rootCause}\nFixability ${t.assessment.fixable.toFixed(2)} · ${t.impact.users} users · ticket ${ticket.id}`,
    };
    const url = ticket.url ?? issue.urls[0];
    if (url) n.url = url;
    await deps.notifier.notify(n);
  }
  return auto
    ? { action: "auto-fix", ticketId: ticket.id }
    : { action: "human", ticketId: ticket.id };
}
