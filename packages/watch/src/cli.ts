import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { TicketStore } from "@matrix/tickets";
import type { GatewayConfig } from "./llm.js";
import { runWatch } from "./run.js";

export const WATCH_USAGE = `matrix watch [dir] [options]   collect tech news for the project, score it and write a weekly digest

Options:
  --days <n>          look-back window (default 7)
  --stack <a,b,c>     stack keywords (default: read from matrix.config.ts when present)
  --goal <text>       product goal used for idea relevance (repeatable)
  --feed <url>        RSS/Atom feed (repeatable)
  --arxiv <query>     arXiv search query
  --lang <name>       GitHub trending language (repeatable)
  --min <0..1>        minimum relevance for the digest and tickets (default 0.5)
  --tickets <dir>     file proposal tickets into a markdown ticket folder
  --include-seen      include items already shown in earlier digests
  --dry-run           print the digest, write nothing
  --json              machine-readable output

Model scoring uses an OpenAI-compatible gateway when MATRIX_GATEWAY_URL and MATRIX_GATEWAY_KEY are set
(model: MATRIX_WATCH_MODEL, default gpt-6.1-sol). Without them a deterministic heuristic scores items.`;

const SKIP = new Set(["true", "false", "none", "yes", "no", "default", "other"]);

/** Best-effort stack keywords from a matrix.config value: short tool-like strings, unique, capped. */
export function stackKeywords(config: unknown, max = 15): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (out.length >= max) return;
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (/^[a-z][a-z0-9.+@/-]{1,30}$/.test(s) && !SKIP.has(s) && !out.includes(s)) out.push(s);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(config);
  return out;
}

async function loadConfigStack(root: string): Promise<string[]> {
  const path = resolve(root, "matrix.config.ts");
  if (!existsSync(path)) return [];
  try {
    const mod = (await import(path)) as { default?: unknown };
    const config = mod.default as Record<string, unknown> | undefined;
    if (!config) return [];
    const { business: _business, product: _product, ...technical } = config;
    return stackKeywords(technical);
  } catch {
    return [];
  }
}

export function gatewayFromEnv(
  env: Record<string, string | undefined> = process.env,
): GatewayConfig | undefined {
  const baseUrl = env.MATRIX_GATEWAY_URL;
  const apiKey = env.MATRIX_GATEWAY_KEY;
  if (!baseUrl || !apiKey) return undefined;
  return { baseUrl, apiKey, model: env.MATRIX_WATCH_MODEL ?? "gpt-6.1-sol" };
}

async function markdownStore(dir: string): Promise<TicketStore> {
  const spec = "@matrix/tickets/adapters/markdown";
  const mod = (await import(spec)) as { MarkdownTicketStore: new (dir: string) => TicketStore };
  return new mod.MarkdownTicketStore(dir);
}

export async function runWatchCli(
  argv: string[],
  out: (line: string) => void = console.log,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      days: { type: "string" },
      stack: { type: "string" },
      goal: { type: "string", multiple: true },
      feed: { type: "string", multiple: true },
      arxiv: { type: "string" },
      lang: { type: "string", multiple: true },
      min: { type: "string" },
      tickets: { type: "string" },
      "include-seen": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    out(WATCH_USAGE);
    return 0;
  }
  const root = resolve(positionals[0] ?? ".");
  const stack = values.stack
    ? values.stack
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : await loadConfigStack(root);
  const gateway = gatewayFromEnv();
  const tickets =
    values.tickets && !values["dry-run"] ? await markdownStore(resolve(values.tickets)) : undefined;
  const result = await runWatch({
    root,
    context: { stack, goals: values.goal ?? [] },
    days: values.days ? Number(values.days) : 7,
    feeds: values.feed ?? [],
    ...(values.arxiv ? { arxivQuery: values.arxiv } : {}),
    languages: values.lang ?? [],
    minRelevance: values.min ? Number(values.min) : 0.5,
    includeSeen: values["include-seen"],
    dryRun: values["dry-run"],
    ...(gateway ? { gateway } : {}),
    ...(tickets ? { tickets } : {}),
  });
  if (values.json) {
    out(
      JSON.stringify(
        {
          week: result.week,
          collected: result.collected,
          fresh: result.fresh,
          relevant: result.relevant.map((r) => ({ title: r.title, url: r.url, ...r.score })),
          digestPath: result.digestPath,
          tickets: result.tickets,
          errors: result.errors,
          scoring: gateway ? `model:${gateway.model}` : "heuristic",
        },
        null,
        2,
      ),
    );
  } else {
    out(result.digest);
    if (result.digestPath) out(`digest written to ${result.digestPath}`);
    if (result.tickets.length) out(`filed ${result.tickets.length} proposal tickets`);
    for (const e of result.errors) out(`warning: ${e.source}: ${e.message}`);
  }
  return 0;
}
