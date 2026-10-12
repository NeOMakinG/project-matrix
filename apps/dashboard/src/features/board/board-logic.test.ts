import { describe, expect, it } from "vitest";
import { tickets } from "@/mocks/data/board";
import { buildColumns, countByKind, filterTickets } from "./board-logic";

describe("board logic", () => {
  it("groups merge, deploy and verify into a Ship column", () => {
    const grouped = buildColumns(tickets, true);
    expect(grouped.map((c) => c.id)).toEqual([
      "spike",
      "implement",
      "checks",
      "review",
      "qa",
      "ship",
    ]);
    expect(grouped.at(-1)?.tickets.map((t) => t.id)).toEqual(["MX-137", "MX-129", "MX-131"]);
  });

  it("shows all eight phases when not grouped", () => {
    const columns = buildColumns(tickets, false);
    expect(columns).toHaveLength(8);
    expect(columns.reduce((n, c) => n + c.tickets.length, 0)).toBe(tickets.length);
  });

  it("filters by kind and search text", () => {
    expect(filterTickets(tickets, "prod-fix", "").map((t) => t.id)).toEqual(["MX-153"]);
    expect(filterTickets(tickets, "all", "pdf").map((t) => t.id)).toEqual(["MX-139", "MX-137"]);
    expect(filterTickets(tickets, "all", "mx-144").map((t) => t.title)).toEqual([
      "Rename invoice states",
    ]);
  });

  it("counts tickets per kind", () => {
    expect(countByKind(tickets)).toEqual({ all: 13, feature: 10, bug: 1, "prod-fix": 1, chore: 1 });
  });
});
