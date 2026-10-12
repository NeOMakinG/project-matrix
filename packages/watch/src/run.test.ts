import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NewTicket, Ticket, TicketStore } from "@matrix/tickets";
import { describe, expect, test } from "vitest";
import { fileProposals } from "./digest.js";
import { completeJson } from "./llm.js";
import { runWatch } from "./run.js";
import { heuristicScore, scoreItems } from "./score.js";
import { type Fetch, ScoreBatchSchema, type WatchItem } from "./types.js";

class FakeTickets implements TicketStore {
  readonly kind = "markdown" as const;
  tickets: Ticket[] = [];
  async list() {
    return this.tickets;
  }
  async get(id: string) {
    return this.tickets.find((t) => t.id === id) ?? null;
  }
  async create(input: NewTicket) {
    const t: Ticket = {
      id: `T-${this.tickets.length + 1}`,
      title: input.title,
      body: input.body,
      status: "open",
      labels: input.labels ?? [],
      deps: [],
      createdAt: "",
      updatedAt: "",
    };
    this.tickets.push(t);
    return t;
  }
  async update(): Promise<Ticket> {
    throw new Error("unused");
  }
  async comment() {}
  async link() {}
  async ready() {
    return [];
  }
}

const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
const recent = new Date(Date.now() - 86_400_000).toISOString();

function router(model: (body: string) => string): { fetch: Fetch; calls: string[] } {
  const calls: string[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push(url);
    if (url.startsWith("https://registry.npmjs.org/zod")) {
      return json({
        "dist-tags": { latest: "5.0.0" },
        time: { "5.0.0": recent },
        repository: { url: "git+https://github.com/colinhacks/zod.git" },
      });
    }
    if (url.startsWith("https://registry.npmjs.org/"))
      return json({ "dist-tags": { latest: "1.0.0" } });
    if (url.startsWith("https://api.github.com/repos/colinhacks/zod/releases")) {
      return json([
        {
          html_url: "https://github.com/colinhacks/zod/releases/v5",
          tag_name: "v5.0.0",
          published_at: recent,
          body: "Zod 5",
        },
      ]);
    }
    if (url === "https://api.osv.dev/v1/querybatch") {
      return json({
        results: [{ vulns: [{ id: "GHSA-test-0001", database_specific: { severity: "HIGH" } }] }],
      });
    }
    if (url.startsWith("https://hn.algolia.com/")) {
      return json({
        hits: [
          {
            objectID: "1",
            title: "Zod 5 ships faster parsing",
            url: "https://example.com/zod5",
            points: 300,
            created_at: recent,
          },
        ],
      });
    }
    if (url.endsWith("/chat/completions")) {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      return json({ choices: [{ message: { content: model(body.messages[1]!.content) } }] });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, calls };
}

const context = {
  name: "demo",
  stack: ["zod"],
  goals: [],
  dependencies: [{ ecosystem: "npm" as const, name: "zod", version: "^4", resolved: "4.1.5" }],
};

describe("runWatch", () => {
  test("collects, scores with the model, writes the digest, files tickets once, remembers seen items", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-watch-"));
    const { fetch, calls } = router((user) => {
      const { items } = JSON.parse(user) as { items: { id: string; source: string }[] };
      return JSON.stringify({
        scores: items.map((i) => ({
          id: i.id,
          relevance: i.source === "osv" ? 0.1 : 0.8,
          kind: "upgrade",
          rationale: "uses zod",
          action: "try it",
        })),
      });
    });
    const tickets = new FakeTickets();
    const gateway = { baseUrl: "http://gw/v1", apiKey: "secret", model: "m", fetch };
    const first = await runWatch({
      root,
      context,
      gateway,
      tickets,
      http: { fetch },
      sources: { trending: false, feeds: false, arxiv: false },
    });
    expect(first.errors).toEqual([]);
    expect(first.relevant.map((r) => r.source).sort()).toEqual([
      "github-release",
      "hn",
      "osv",
      "registry",
    ]);
    const osv = first.scored.find((s) => s.source === "osv")!;
    expect(osv.score).toMatchObject({ kind: "risk", relevance: 0.9 });
    expect(await readFile(first.digestPath!, "utf8")).toContain("## Risks");
    expect(tickets.tickets.find((t) => t.labels.includes("watch:risk"))?.title).toContain(
      "GHSA-test-0001",
    );
    expect(calls.filter((c) => c.includes("chat/completions"))).toHaveLength(1);

    const second = await runWatch({
      root,
      context,
      gateway,
      tickets,
      http: { fetch },
      sources: { trending: false, feeds: false, arxiv: false },
    });
    expect(second.fresh).toBe(0);
    expect(tickets.tickets).toHaveLength(first.tickets.length);
  });

  test("falls back to heuristics when the model output is invalid twice", async () => {
    const { fetch } = router(() => "not json");
    const items: WatchItem[] = [
      { id: "hn:1", source: "hn", title: "zod tips", url: "https://x", summary: "" },
    ];
    const scored = await scoreItems(items, context, {
      baseUrl: "http://gw/v1",
      apiKey: "k",
      model: "m",
      fetch,
    });
    expect(scored[0]!.score).toEqual(heuristicScore(items[0]!, context));
  });

  test("completeJson retries once with the validation error", async () => {
    let n = 0;
    const fetch: Fetch = async () => {
      n += 1;
      const content = n === 1 ? '{"scores":[{"id":1}]}' : '```json\n{"scores":[]}\n```';
      return json({ choices: [{ message: { content } }] });
    };
    await expect(
      completeJson(
        { baseUrl: "http://gw", apiKey: "k", model: "m", fetch },
        "s",
        "u",
        ScoreBatchSchema,
      ),
    ).resolves.toEqual({ scores: [] });
    expect(n).toBe(2);
  });

  test("fileProposals skips items already ticketed", async () => {
    const tickets = new FakeTickets();
    const item = {
      id: "registry:npm:zod@5.0.0",
      source: "registry" as const,
      title: "zod 5",
      url: "u",
      summary: "",
    };
    const scored = [
      {
        ...item,
        score: {
          id: item.id,
          relevance: 0.9,
          kind: "upgrade" as const,
          rationale: "r",
          action: "a",
        },
      },
    ];
    expect(await fileProposals(tickets, scored, 0.5)).toHaveLength(1);
    expect(await fileProposals(tickets, scored, 0.5)).toHaveLength(0);
  });
});
