import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PRODUCT_GRAPH_PATH, parseProductGraph, serializeProductGraph } from "@matrix/graph";
import type { TicketStore } from "@matrix/tickets";
import { MarkdownTicketStore } from "@matrix/tickets/adapters/markdown";
import type { PrivateStateOwner } from "../state-owner.js";

export interface TrackerJournal {
  files: Record<string, string>;
  ticketMap?: Record<string, string>;
  ticketIntents?: string[];
}

export async function mirrorBacklog(input: {
  projectId: string;
  sessionId: string;
  journal: TrackerJournal;
  tickets: TicketStore;
  save: () => void;
  stateOwner?: PrivateStateOwner | undefined;
}): Promise<string[]> {
  const { journal } = input;
  const check = () => input.stateOwner?.assertOwned();
  const tickets = input.stateOwner?.fence(input.tickets) ?? input.tickets;
  check();
  journal.ticketMap ??= {};
  journal.ticketIntents ??= [];
  const directory = await mkdtemp(join(tmpdir(), "matrix-backlog-mirror-"));
  try {
    check();
    for (const [path, content] of Object.entries(journal.files)) {
      if (!path.startsWith(".matrix/tickets/")) continue;
      if (path.split("/").some((part) => part === ".." || part === "." || !part))
        throw new Error("invalid generated backlog path");
      await mkdir(dirname(join(directory, path)), { recursive: true, mode: 0o700 });
      check();
      await writeFile(join(directory, path), content, { mode: 0o600 });
      check();
    }
    const markdown = new MarkdownTicketStore(join(directory, ".matrix/tickets"), {
      root: directory,
    });
    const source = await markdown.list();
    check();
    const existing = await tickets.list();
    check();
    for (const ticket of source) {
      const digest = createHash("sha256")
        .update(JSON.stringify([input.projectId, input.sessionId, ticket.id]))
        .digest("hex");
      const marker = `<!-- matrix-init-ticket:${digest} -->`;
      const matches = existing.filter((actual) => actual.body.includes(marker));
      if (matches.length > 1) throw new Error("ambiguous init ticket marker");
      const mapped = journal.ticketMap[ticket.id];
      if (mapped) {
        if (!existing.some((actual) => actual.id === mapped))
          throw new Error("previously mirrored ticket is missing; refusing recreation");
        continue;
      }
      if (matches[0]) {
        journal.ticketMap[ticket.id] = matches[0].id;
        input.save();
        continue;
      }
      if (journal.ticketIntents.includes(ticket.id))
        throw new Error("ambiguous tracker create; reconcile its init marker before retrying");
      journal.ticketIntents.push(ticket.id);
      input.save();
      check();
      const created = await tickets.create({
        title: ticket.title,
        body: `${ticket.body}\n\n${marker}`,
        labels: ticket.labels,
        ...(ticket.priority === undefined ? {} : { priority: ticket.priority }),
      });
      check();
      journal.ticketMap[ticket.id] = created.id;
      existing.push(created);
      input.save();
    }
    const actualId = (sourceId: string) => {
      const actual = journal.ticketMap?.[sourceId];
      if (!actual) throw new Error("generated backlog references an unmapped ticket");
      return actual;
    };
    for (const ticket of source) {
      check();
      await tickets.update(actualId(ticket.id), {
        deps: ticket.deps.map(actualId),
        ...(ticket.parent ? { parent: actualId(ticket.parent) } : {}),
      });
      check();
    }
    const content = journal.files[PRODUCT_GRAPH_PATH];
    if (content) {
      const graph = parseProductGraph(JSON.parse(content));
      const remap = (id: string) =>
        id.startsWith("ticket:") && journal.ticketMap?.[id.slice(7)]
          ? `ticket:${actualId(id.slice(7))}`
          : id;
      const nodes = new Map(
        graph.nodes.map((node) => {
          const id = node.kind === "ticket" ? remap(node.id) : node.id;
          return [id, { ...node, id }] as const;
        }),
      );
      const edges = new Map(
        graph.edges.map((edge) => {
          const updated = { ...edge, from: remap(edge.from), to: remap(edge.to) };
          return [JSON.stringify(updated), updated] as const;
        }),
      );
      journal.files[PRODUCT_GRAPH_PATH] = serializeProductGraph({
        ...graph,
        nodes: [...nodes.values()],
        edges: [...edges.values()],
      });
      input.save();
    }
    return source.map((ticket) => actualId(ticket.id));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
