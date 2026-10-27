import type { DeployPort, PhaseContext, Receipt, VerifyPort } from "@matrix/core";
import type { LineExecutor } from "@matrix/sandbox";
import { assertPublicUrl, flyReleases, runOnHost } from "./deploy-hosts.js";
import { type DeployHost, type DeployPlan, planDeploy, renderPlan } from "./deploy-plan.js";
import { externalRepo, type GitHubPullRequests } from "./github-pr.js";

export interface DeployStageOptions {
  prs: Pick<GitHubPullRequests, "mergedInfo">;
  hosts: DeployHost[];
  /** Deck note before a coordinated deploy (best effort is NOT enough: a failure holds). */
  deckNote?: (summary: string) => Promise<void>;
  executor?: LineExecutor;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => Date;
  /** Health/version polling: attempts and spacing. */
  polls?: { attempts: number; everyMs: number };
}

/** Per-target lock: deploy, verify and rollback of one target never overlap in this process. */
const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}

/** Plan of the ticket's merged PR (shared by deploy and verify). */
export async function ticketPlan(
  o: DeployStageOptions,
  ctx: PhaseContext,
): Promise<{ plan: DeployPlan; url: string } | string> {
  const profile = ctx.project.deploy;
  const github = externalRepo(ctx.project)?.github;
  if (!profile || !github) return "project has no deploy profile";
  const merged = await o.prs.mergedInfo(ctx.project, ctx.ticket.id);
  if (!merged) return "the ticket's pull request is not merged";
  return {
    url: merged.url,
    plan: planDeploy({
      profile,
      files: merged.files,
      hosts: o.hosts,
      repo: github,
      mergeCommit: merged.mergeCommit,
    }),
  };
}

const MIN = 60_000;

/** Runs `command` targets on a capable host; git-integration targets deploy themselves. */
export function deployPort(o: DeployStageOptions): DeployPort {
  return {
    async deploy(ctx) {
      const got = await ticketPlan(o, ctx);
      if (typeof got === "string") return { ok: false, blocked: true, summary: got };
      const { plan } = got;
      const profile = ctx.project.deploy!;
      const receipts: Receipt[] = [
        {
          kind: "log",
          ok: true,
          summary: `deploy plan`,
          data: { plan: renderPlan(plan, profile) },
        },
      ];
      if (plan.dryRun)
        return { ok: true, summary: `dry run: ${renderPlan(plan, profile)}`, receipts };
      const held: string[] = [];
      for (const step of plan.steps) {
        if (step.action === "hold" || step.action === "block") {
          held.push(`${step.target}: ${step.reason}`);
          continue;
        }
        if (step.action !== "run") continue;
        const target = profile.targets.find((t) => t.name === step.target)!;
        const host = o.hosts.find((h) => h.name === step.host)!;
        const result = await withLock(`${plan.repo}:${target.name}`, async () => {
          if (target.coordinate && target.rollback) {
            const since =
              (o.clock?.() ?? new Date()).getTime() -
              target.coordinate.recentForeignDeployMinutes * MIN;
            const recent = (await flyReleases(host, target.rollback.app, o.executor)).filter(
              (r) => Date.parse(r.createdAt) >= since && !r.image.includes(":matrix-"),
            );
            if (recent.length)
              return `held: ${recent[0]?.user || "another actor"} released ${target.rollback.app} v${recent[0]?.version} within ${target.coordinate.recentForeignDeployMinutes} min`;
            if (target.coordinate.deck) {
              if (!o.deckNote) return "held: coordinated target but no deck note configured";
              await o.deckNote(
                `Matrix deploying ${target.name} ${plan.mergeCommit.slice(0, 12)} on ${host.name}`,
              );
            }
          }
          const run = await runOnHost(host, step.argv!, {
            checkout: { repo: plan.repo, sha: plan.mergeCommit },
            timeoutMs: 30 * MIN,
            signal: ctx.signal,
            ...(o.executor ? { executor: o.executor } : {}),
          });
          receipts.push({
            kind: "log",
            ok: run.exitCode === 0,
            summary: `${target.name}: ${step.argv!.join(" ")} on ${host.name} exit ${run.exitCode}`,
            data: { tail: run.tail },
          });
          return run.exitCode === 0 ? null : `failed: ${target.name} exit ${run.exitCode}`;
        });
        if (result?.startsWith("held")) held.push(`${target.name}: ${result}`);
        else if (result) return { ok: false, blocked: true, summary: result, receipts };
      }
      if (held.length)
        return {
          ok: false,
          blocked: true,
          summary: `merged; deploy held: ${held.join("; ")}`.slice(0, 600),
          receipts,
        };
      return { ok: true, summary: `deployed ${plan.mergeCommit.slice(0, 12)}`, receipts };
    },
  };
}

async function poll(
  o: DeployStageOptions,
  probe: () => Promise<string | null>,
): Promise<string | null> {
  const { attempts, everyMs } = o.polls ?? { attempts: 20, everyMs: 30_000 };
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let last: string | null = "not probed";
  for (let i = 0; i < attempts; i++) {
    last = await probe().catch((e: Error) => e.message.slice(0, 200));
    if (last === null) return null;
    if (i < attempts - 1) await sleep(everyMs);
  }
  return last;
}

async function httpStatus(
  o: DeployStageOptions,
  url: string,
): Promise<{ status: number; body: string }> {
  await assertPublicUrl(url);
  const res = await (o.fetch ?? fetch)(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, body: await boundedText(res, 20_000) };
}

/** Reads at most `max` bytes of a response body, then cancels the stream. */
async function boundedText(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => undefined);
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max));
}

/**
 * Proves the merged commit reached production (provider version document or our Fly release),
 * then polls health. A failing `command` target is rolled back to the previous image, but only
 * while the current release is still ours. Every outcome posts one receipt comment.
 */
export function verifyPort(o: DeployStageOptions): VerifyPort {
  return {
    async verify(ctx) {
      const got = await ticketPlan(o, ctx);
      if (typeof got === "string") return { receipts: [], blocked: got };
      const { plan } = got;
      const profile = ctx.project.deploy!;
      const sha = plan.mergeCommit;
      const receipts: Receipt[] = [];
      for (const step of plan.steps) {
        const t = profile.targets.find((x) => x.name === step.target)!;
        if (step.action === "skip" || step.action === "dry-run" || plan.dryRun) {
          receipts.push({
            kind: "log",
            ok: true,
            summary: `${t.name}: ${plan.dryRun ? "dry run" : step.reason}`,
          });
          continue;
        }
        if (step.action === "hold" || step.action === "block") {
          receipts.push({ kind: "log", ok: false, summary: `${t.name}: ${step.reason}` });
          continue;
        }
        await withLock(`${plan.repo}:${t.name}`, async () => {
          let proof: string | null;
          if (t.kind === "git-integration" && t.version) {
            const v = t.version;
            proof = await poll(o, async () => {
              const r = await httpStatus(o, v.url);
              const commit = String((JSON.parse(r.body) as Record<string, unknown>)[v.field] ?? "");
              return commit === sha
                ? null
                : `production serves ${commit.slice(0, 12) || "?"}, not ${sha.slice(0, 12)}`;
            });
          } else {
            const host = o.hosts.find((h) => h.name === step.host)!;
            const app = t.rollback?.app ?? "";
            const top = app ? (await flyReleases(host, app, o.executor))[0] : undefined;
            proof = top?.image.endsWith(`:matrix-${sha.slice(0, 12)}`)
              ? null
              : `newest release is not ours (${top?.image ?? "none"})`;
          }
          receipts.push({
            kind: "curl",
            ok: proof === null,
            summary: `${t.name}: ${proof ?? `production serves ${sha.slice(0, 12)}`}`,
          });
          if (proof === null && t.health) {
            const h = t.health;
            const bad = await poll(o, async () => {
              const r = await httpStatus(o, h.url);
              return r.status === h.expect
                ? null
                : `GET ${h.url} ${r.status} (expected ${h.expect})`;
            });
            receipts.push({
              kind: "curl",
              ok: bad === null,
              summary: `${t.name}: ${bad ?? `GET ${h.url} ${h.expect}`}`,
            });
            // A shared app (another fleet deploys it) has no writer lock covering everyone: no
            // automatic rollback there, the failing receipt asks a human (ADR 0007 section 4).
            if (bad && t.kind === "command")
              receipts.push(
                t.coordinate
                  ? {
                      kind: "log",
                      ok: false,
                      summary: `${t.name}: health failed on a shared app; not rolled back automatically, a human decides (fly deploy -a ${t.rollback?.app} --image <previous>)`,
                    }
                  : await rollback(o, step.host!, t.rollback?.app, sha),
              );
          }
        });
      }
      await postReceipt(ctx, plan.mergeCommit, got.url, receipts);
      return { receipts };
    },
  };
}

async function rollback(
  o: DeployStageOptions,
  hostName: string,
  app: string | undefined,
  sha: string,
): Promise<Receipt> {
  const host = o.hosts.find((h) => h.name === hostName);
  if (!host || !app)
    return { kind: "log", ok: false, summary: "rollback: no host or app; needs a human" };
  const releases = await flyReleases(host, app, o.executor);
  const [current, previous] = [
    releases[0],
    releases.find((r, i) => i > 0 && r.status === "complete"),
  ];
  // Re-read right before acting: a newer release (human, other fleet) is never rolled back.
  if (!current?.image.endsWith(`:matrix-${sha.slice(0, 12)}`) || !previous?.image)
    return {
      kind: "log",
      ok: false,
      summary: `rollback skipped: current ${app} release is not ours; needs a human`,
    };
  const run = await runOnHost(
    host,
    ["fly", "deploy", "-a", app, "--image", previous.image, "--now"],
    {
      timeoutMs: 20 * MIN,
      ...(o.executor ? { executor: o.executor } : {}),
    },
  );
  return {
    kind: "log",
    ok: false,
    summary: `rolled back ${app} to v${previous.version} (${run.exitCode === 0 ? "ok" : `exit ${run.exitCode}`})`,
    data: { tail: run.tail },
  };
}

async function postReceipt(
  ctx: PhaseContext,
  sha: string,
  url: string,
  receipts: Receipt[],
): Promise<void> {
  const ok = receipts.every((r) => r.ok);
  const body = [
    `Matrix deploy receipt for ${sha.slice(0, 12)} (${url}): ${ok ? "PASS" : "FAIL / HELD"}`,
    ...receipts.map((r) => `- ${r.ok ? "ok" : "FAIL"}: ${r.summary}`),
  ].join("\n");
  await ctx.tickets.comment(ctx.ticket.id, body).catch(() => undefined);
}
