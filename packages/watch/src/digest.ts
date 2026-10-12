import type { NewTicket, TicketStore } from "@matrix/tickets";
import type { ProposalKind, ScoredItem } from "./types.js";

export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const SECTIONS: { kind: ProposalKind; title: string }[] = [
  { kind: "risk", title: "Risks" },
  { kind: "upgrade", title: "Upgrades" },
  { kind: "idea", title: "Ideas" },
];

export function relevant(items: ScoredItem[], minRelevance: number): ScoredItem[] {
  return items
    .filter((i) => i.score.kind !== "ignore" && i.score.relevance >= minRelevance)
    .sort((a, b) => b.score.relevance - a.score.relevance || a.id.localeCompare(b.id));
}

export function renderDigest(
  project: string,
  week: string,
  items: ScoredItem[],
  minRelevance: number,
): string {
  const kept = relevant(items, minRelevance);
  const lines = [
    `# Tech watch: ${project}, ${week}`,
    "",
    `${kept.length} relevant of ${items.length} new items.`,
    "",
  ];
  for (const section of SECTIONS) {
    const list = kept.filter((i) => i.score.kind === section.kind);
    if (!list.length) continue;
    lines.push(`## ${section.title}`, "");
    for (const i of list) {
      lines.push(
        `- **[${i.title}](${i.url})** (${i.score.relevance.toFixed(2)}): ${i.score.rationale} Next: ${i.score.action}`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function proposalTicket(item: ScoredItem): NewTicket {
  const prefix = { risk: "Risk", upgrade: "Upgrade", idea: "Idea", ignore: "Note" }[
    item.score.kind
  ];
  return {
    title: `${prefix}: ${item.title}`.slice(0, 120),
    body: [
      item.score.rationale,
      "",
      `Next step: ${item.score.action}`,
      "",
      `Source: ${item.url}`,
      `Watch id: ${item.id}`,
      `Relevance: ${item.score.relevance.toFixed(2)}`,
    ].join("\n"),
    labels: ["watch", `watch:${item.score.kind}`],
    priority:
      item.score.kind === "risk"
        ? item.severity === "critical" || item.severity === "high"
          ? 1
          : 2
        : 3,
  };
}

/** Files proposal tickets for items above `minRelevance`, skipping any whose watch id is already in an open or closed ticket. */
export async function fileProposals(
  store: TicketStore,
  items: ScoredItem[],
  minRelevance: number,
  max = 10,
): Promise<string[]> {
  const existing = await store.list({ labels: ["watch"] });
  const known = new Set(
    existing.flatMap((t) => [...(/Watch id: (\S+)/.exec(t.body)?.slice(1) ?? [])]),
  );
  const created: string[] = [];
  for (const item of relevant(items, minRelevance)) {
    if (created.length >= max) break;
    if (known.has(item.id)) continue;
    const ticket = await store.create(proposalTicket(item));
    created.push(ticket.id);
  }
  return created;
}
