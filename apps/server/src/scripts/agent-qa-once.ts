/**
 * One-off agent QA run on an existing draft PR, outside the reconciler (for tickets handed off
 * before `qa.driver: "agent"` existed). Posts the same report and labels the reconciler would; on
 * FAIL it moves the ticket back to Ready, which Matrix takes as QA feedback (review loop).
 *
 *   secrets run -- bun apps/server/src/scripts/agent-qa-once.ts <lane.json> <projectId> <TICKET> <PR url> [--dry-run]
 */

import { execFileSync } from "node:child_process";
import {
  type AgentQaRequest,
  acceptanceCriteria,
  QA_FAILED_LABEL,
  QA_PASSED_LABEL,
  renderAgentQaReport,
} from "@matrix/core";
import { NEEDS_HUMAN_LABEL } from "@matrix/tickets";
import { LinearTicketStore } from "@matrix/tickets/adapters/linear";
import { loadLaneConfig, SshAgentQaLane } from "../integration/agent-qa-lane.js";

const [laneFile, projectId, ticketId, prUrl, flag] = process.argv.slice(2);
if (!laneFile || !projectId || !ticketId || !prUrl) {
  console.error("usage: agent-qa-once.ts <lane.json> <projectId> <TICKET> <PR url> [--dry-run]");
  process.exit(2);
}
const dry = flag === "--dry-run";
const pr = prUrl.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/);
if (!pr?.[1] || !pr[2]) throw new Error("bad PR url");
const repo = pr[1];
const number = Number(pr[2]);

const tickets = new LinearTicketStore({
  teamKey: "NEO",
  projectLabel: "project:travel-journal",
  app: {
    clientIdEnv: "LINEAR_MATRIX_APP_CLIENT_ID",
    clientSecretEnv: "LINEAR_MATRIX_APP_CLIENT_SECRET",
  },
});
const ticket = await tickets.get(ticketId);
if (!ticket) throw new Error(`${ticketId} not found`);
const comments = (await tickets.listComments(ticketId)).filter((c) => !c.byMatrix);
const gh = (args: string[]) => {
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    console.error(
      `[agent-qa] gh ${args.slice(0, 2).join(" ")} failed: ${(error as Error).message.slice(0, 200)}`,
    );
    return "";
  }
};
const headSha = gh([
  "pr",
  "view",
  String(number),
  "--repo",
  repo,
  "--json",
  "headRefOid",
  "-q",
  ".headRefOid",
]).trim();
if (!/^[a-f0-9]{40}$/.test(headSha)) throw new Error("could not read the PR head");

const lane = new SshAgentQaLane(loadLaneConfig(laneFile));
const criteria = acceptanceCriteria(ticket.body);
const request: AgentQaRequest = {
  project: { id: projectId } as AgentQaRequest["project"],
  ticket: {
    id: ticket.id,
    title: ticket.title,
    body: ticket.body,
    comments: comments.slice(-20).map((c) => c.body),
  },
  pullRequest: { url: prUrl, number, repo },
  headSha,
  surfaces: ["android"],
  criteria,
  signal: new AbortController().signal,
};
console.error(
  `[agent-qa] ${ticketId} ${repo}#${number} @ ${headSha.slice(0, 12)}: ${criteria.length} criteria`,
);
const outcome = await lane.run(request);
const images = new Map<string, string>();
if (outcome.kind === "report" && !dry)
  for (const shot of outcome.screenshots)
    images.set(shot.name, await tickets.uploadFile(ticketId, shot.name, "image/png", shot.bytes));
const rendered = renderAgentQaReport(outcome, {
  headSha,
  qaRun: "manual-rerun",
  pullRequestUrl: prUrl,
  images,
  criteriaCount: criteria.length,
});
console.log(rendered.body);
if (dry) process.exit(0);
await tickets.comment(ticketId, rendered.body);
const prLabels = (add: string[], remove: string[]) => {
  for (const l of [...add, ...remove])
    gh([
      "label",
      "create",
      l,
      "--repo",
      repo,
      "--force",
      "--color",
      l.endsWith("failed") ? "d73a4a" : "0e8a16",
    ]);
  const args = ["pr", "edit", String(number), "--repo", repo];
  for (const l of add) args.push("--add-label", l);
  for (const l of remove) args.push("--remove-label", l);
  gh(args);
};
if (rendered.verdict === "PASS") {
  await tickets.addLabel(ticketId, QA_PASSED_LABEL);
  await tickets.removeLabel(ticketId, QA_FAILED_LABEL);
  prLabels([QA_PASSED_LABEL], [QA_FAILED_LABEL]);
} else if (rendered.verdict === "FAIL") {
  await tickets.addLabel(ticketId, QA_FAILED_LABEL);
  await tickets.removeLabel(ticketId, QA_PASSED_LABEL);
  prLabels([QA_FAILED_LABEL], [QA_PASSED_LABEL]);
  await tickets.update(ticketId, { status: "ready" });
} else {
  await tickets.addLabel(ticketId, NEEDS_HUMAN_LABEL);
}
console.error(`[agent-qa] ${ticketId}: ${rendered.verdict}`);
