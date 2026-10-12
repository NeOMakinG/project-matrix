import { PHASES, type Phase, type Ticket, type TicketKind } from "@/api/schemas";

export type KindFilter = "all" | TicketKind;

export const KIND_FILTERS: { id: KindFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "feature", label: "Features" },
  { id: "bug", label: "Bugs" },
  { id: "prod-fix", label: "Prod fixes" },
  { id: "chore", label: "Chores" },
];

const SHIP_PHASES: readonly Phase[] = ["merge", "deploy", "verify"];

const PHASE_LABEL: Record<Phase, string> = {
  spike: "Spike",
  implement: "Implement",
  checks: "Checks",
  review: "Review",
  qa: "QA",
  merge: "Merge",
  deploy: "Deploy",
  verify: "Verify",
};

export type BoardColumn = { id: string; label: string; tickets: Ticket[] };

export function filterTickets(tickets: Ticket[], kind: KindFilter, search: string): Ticket[] {
  const needle = search.trim().toLowerCase();
  return tickets.filter(
    (t) =>
      (kind === "all" || t.kind === kind) &&
      (!needle || t.title.toLowerCase().includes(needle) || t.id.toLowerCase().includes(needle)),
  );
}

export function countByKind(tickets: Ticket[]): Record<KindFilter, number> {
  const counts: Record<KindFilter, number> = {
    all: tickets.length,
    feature: 0,
    bug: 0,
    "prod-fix": 0,
    chore: 0,
  };
  for (const t of tickets) counts[t.kind] += 1;
  return counts;
}

export function buildColumns(tickets: Ticket[], groupShip: boolean): BoardColumn[] {
  const byPhase = (phases: readonly Phase[]) => tickets.filter((t) => phases.includes(t.phase));
  const columns: BoardColumn[] = [];
  for (const phase of PHASES) {
    if (groupShip && SHIP_PHASES.includes(phase)) continue;
    columns.push({ id: phase, label: PHASE_LABEL[phase], tickets: byPhase([phase]) });
  }
  if (groupShip) columns.push({ id: "ship", label: "Ship", tickets: byPhase(SHIP_PHASES) });
  return columns;
}
