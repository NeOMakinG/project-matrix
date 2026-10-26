#!/usr/bin/env node
// Matrix agent QA lane, iOS driver: the QA agent's only simulator tool. Talks to the tapflow relay
// (WebSocket + REST, PAT in the Authorization header) and is locked to ONE simulator, QA_UDID: the
// agent cannot list, boot, install on or drive any other device.
// Env (set by the lane): TAPFLOW_RELAY_WS (ws), TAPFLOW_TOKEN, QA_UDID. Screenshots come from the lane's
// ./qa-shot (simctl over SSH): the relay's screenshot/UI-tree routes need a relay-installed build.
import { randomUUID } from "node:crypto";

const { TAPFLOW_RELAY_WS, TAPFLOW_TOKEN, QA_UDID } = process.env;
const fail = (m, code = 2) => {
  console.error(m);
  process.exit(code);
};
if (!TAPFLOW_RELAY_WS || !TAPFLOW_TOKEN || !QA_UDID) fail("lane environment missing");
const auth = { Authorization: `Bearer ${TAPFLOW_TOKEN}` };

const HELP = `usage: ./qa-ios <command>   (the simulator ${QA_UDID})
  tap <x> <y>                 tap; x/y in SCREENSHOT PIXELS (from ./qa-shot images)
  swipe <x1> <y1> <x2> <y2>   swipe in screenshot pixels (edge-swipe back: 5 1300 700 1300)
  type <text>                 type into the focused field
  key <code>                  keyboard key (Enter, Backspace, Escape, Tab)
  button <name>               hardware button (home, lock)
See the screen with ./qa-shot <name> (writes out/shots/<name>.png; Read that file to look at it).`;

const [cmd, ...args] = process.argv.slice(2);
if (!cmd || cmd === "help") {
  console.log(HELP);
  process.exit(0);
}

async function session() {
  const ws = new WebSocket(TAPFLOW_RELAY_WS, { headers: auth });
  const inbox = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    const w = waiters.findIndex((x) => x.match(m));
    if (w >= 0) waiters.splice(w, 1)[0].resolve(m);
    else inbox.push(m);
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("relay unreachable"));
  });
  const wait = (match, ms) =>
    new Promise((resolve, reject) => {
      const i = inbox.findIndex(match);
      if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
      const t = setTimeout(() => reject(new Error("relay did not answer")), ms);
      waiters.push({ match, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  const send = (m) => ws.send(JSON.stringify(m));
  send({ type: "agents:list" });
  const listed = await wait((m) => m.type === "agents:listed", 8_000);
  const device = (listed.sessions ?? [])
    .flatMap((s) => s.devices ?? [])
    .find((d) => d.id === QA_UDID);
  if (!device?.sessionId) fail(`simulator ${QA_UDID} is not on the relay`, 1);
  const id = device.sessionId;
  send({ type: "session:start", sessionId: id });
  const joined = await wait(
    (m) => m.sessionId === id && (m.type === "session:joined" || m.type === "error"),
    8_000,
  );
  if (joined.type === "error")
    fail(`could not join the simulator: ${joined.message ?? "error"}`, 1);
  // Resolves true when done, false when the session's input channel was not ready yet.
  const ack = async (requestId, done = "input:done", err = "input:error") => {
    const m = await wait(
      (x) => x.requestId === requestId && (x.type === done || x.type === err),
      15_000,
    ).catch(() => ({ type: done }));
    if (m.type === err && /still starting|no gesture is in progress/i.test(m.message ?? ""))
      return false;
    if (m.type === err) fail(m.message ?? "input failed", 1);
    return true;
  };
  return { id, send, ack, close: () => ws.close() };
}

const num = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 5000) fail("coordinates must be numbers");
  return n;
};

try {
  const s = await session();
  // A fresh session's input channel takes a moment: retry the whole input until it is ready.
  for (let attempt = 0; attempt < 12; attempt++) {
    const requestId = randomUUID();
    if (await input(s, requestId)) {
      s.close();
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  fail("the simulator's input channel did not become ready", 1);
} catch (error) {
  fail(String(error?.message ?? error).slice(0, 300), 1);
}

async function input(s, requestId) {
  if (cmd === "tap") {
    const payload = { x: num(args[0]), y: num(args[1]) };
    s.send({ type: "input:touch:start", sessionId: s.id, payload });
    await new Promise((r) => setTimeout(r, 60));
    s.send({ type: "input:touch:end", sessionId: s.id, requestId, payload });
    if (!(await s.ack(requestId))) return false;
    console.log(`tapped ${payload.x},${payload.y}`);
    return true;
  }
  if (cmd === "swipe") {
    const [x1, y1, x2, y2] = args.slice(0, 4).map(num);
    s.send({ type: "input:touch:start", sessionId: s.id, payload: { x: x1, y: y1 } });
    for (let i = 1; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 40));
      s.send({
        type: "input:touch:move",
        sessionId: s.id,
        payload: { x: x1 + ((x2 - x1) * i) / 8, y: y1 + ((y2 - y1) * i) / 8 },
      });
    }
    s.send({ type: "input:touch:end", sessionId: s.id, requestId, payload: { x: x2, y: y2 } });
    return s.ack(requestId);
  }
  if (cmd === "type") {
    s.send({
      type: "input:type",
      sessionId: s.id,
      requestId,
      payload: { text: args.join(" ").slice(0, 500) },
    });
    return s.ack(requestId, "input:type-done", "input:type-error");
  }
  if (cmd === "key") {
    s.send({
      type: "input:key",
      sessionId: s.id,
      requestId,
      payload: { code: args[0] ?? "Enter", modifiers: 0 },
    });
    return s.ack(requestId);
  }
  if (cmd === "button") {
    if (!["home", "lock"].includes(args[0] ?? "")) fail("button must be home or lock");
    s.send({ type: "input:button", sessionId: s.id, requestId, payload: { name: args[0] } });
    return s.ack(requestId);
  }
  fail(HELP);
}
