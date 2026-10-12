import { describe, expect, test } from "vitest";
import { AGENT, setup } from "./test-helpers.js";

async function readEvents(
  response: Response,
  count: number,
): Promise<{ event: string; data: string }[]> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("no body");
  const decoder = new TextDecoder();
  const events: { event: string; data: string }[] = [];
  let buffer = "";
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
      events.push({ event, data });
      index = buffer.indexOf("\n\n");
    }
  }
  await reader.cancel();
  return events;
}

describe("run event stream", () => {
  test("streams run events to an authorized key", async () => {
    const ctx = await setup();
    const ticket = await ctx.core.createTicket(ctx.project.id, { title: "t", body: "" });
    const run = await ctx.core.startRun(
      {
        projectId: ctx.project.id,
        ticketId: ticket.id,
        phase: "implement",
      },
      AGENT,
    );
    const response = await ctx.call(ctx.key(["read"]), "GET", `/v1/runs/${run.id}/events`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const pending = readEvents(response, 3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    ctx.core.emit({ runId: run.id, at: new Date().toISOString(), kind: "log", message: "tsc ok" });
    ctx.core.emit({ runId: run.id, at: new Date().toISOString(), kind: "cost", message: "$0.12" });
    const events = await pending;

    expect(events.map((e) => e.event)).toEqual(["ready", "log", "cost"]);
    expect(JSON.parse(events[1]?.data ?? "{}")).toMatchObject({ message: "tsc ok" });
  });

  test("refuses streams for runs outside the key's projects", async () => {
    const ctx = await setup();
    const ticket = await ctx.core.createTicket(ctx.other.id, { title: "t", body: "" });
    const run = await ctx.core.startRun(
      {
        projectId: ctx.other.id,
        ticketId: ticket.id,
        phase: "qa",
      },
      AGENT,
    );
    expect((await ctx.call(ctx.key(["read"]), "GET", `/v1/runs/${run.id}/events`)).status).toBe(
      403,
    );
    expect((await ctx.call(null, "GET", `/v1/runs/${run.id}/events`)).status).toBe(401);
  });
});
