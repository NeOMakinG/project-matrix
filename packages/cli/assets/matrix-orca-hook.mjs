#!/usr/bin/env node
// Matrix agent hook for Orca-launched agents. Posts the agent's status to the Matrix server, signed
// the way POST /hooks/orca verifies it. Never blocks or fails the agent: always exits 0 within ~2s.
//   node matrix-orca-hook.mjs <agent> [codex-notify-json]
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STATUS = {
  SessionStart: "started",
  UserPromptSubmit: "working",
  PreToolUse: "working",
  PostToolUse: "working",
  Notification: "waiting",
  Stop: "idle",
  SubagentStop: "working",
  SessionEnd: "done",
  "agent-turn-complete": "idle",
};

function readEnv(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0 && !line.startsWith("#")) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return env;
}

function readStdin() {
  try {
    return process.stdin.isTTY ? "" : readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

async function main() {
  const agent = process.argv[2] || "unknown";
  const raw = process.argv[3] ?? readStdin();
  let event = {};
  try {
    event = raw ? JSON.parse(raw) : {};
  } catch {}
  const name = event.hook_event_name ?? event.type ?? "";
  const status = STATUS[name];
  if (!status) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const env = readEnv(process.env.MATRIX_ORCA_HOOK_ENV || join(here, "hook.env"));
  if (!env.MATRIX_URL || !env.MATRIX_ORCA_SECRET) return;
  const body = JSON.stringify({
    worktree: process.env.ORCA_WORKTREE_ID || event.cwd || process.cwd(),
    agent,
    status,
    ...(process.env.MATRIX_RUN_ID ? { runId: process.env.MATRIX_RUN_ID } : {}),
    message: String(event.message ?? event["last-assistant-message"] ?? name).slice(0, 2000),
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(24).toString("base64url");
  const signature = createHmac("sha256", env.MATRIX_ORCA_SECRET)
    .update(`${timestamp}.${nonce}.${body}`)
    .digest("hex");
  await fetch(`${env.MATRIX_URL.replace(/\/$/, "")}/hooks/orca`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-orca-timestamp": String(timestamp),
      "x-orca-nonce": nonce,
      "x-orca-signature": `sha256=${signature}`,
    },
    body,
    signal: AbortSignal.timeout(1500),
  });
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
