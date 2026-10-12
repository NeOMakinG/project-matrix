import { createHmac, randomBytes } from "node:crypto";

export type OrcaHookHeaders = {
  "content-type": "application/json";
  "x-orca-timestamp": string;
  "x-orca-nonce": string;
  "x-orca-signature": string;
};

/** Signs an Orca agent-hook body the way the Matrix server verifies it (`POST /hooks/orca`). */
export function signOrcaHook(
  secret: string,
  body: string,
  timestamp: number = Math.floor(Date.now() / 1000),
  nonce: string = randomBytes(24).toString("base64url"),
): OrcaHookHeaders {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce))
    throw new Error("nonce must be 16-128 url-safe chars");
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${nonce}.${body}`)
    .digest("hex");
  return {
    "content-type": "application/json",
    "x-orca-timestamp": String(timestamp),
    "x-orca-nonce": nonce,
    "x-orca-signature": `sha256=${signature}`,
  };
}

/** Agent hook event → Matrix status. Unknown events are ignored. */
export const HOOK_STATUS: Record<string, string> = {
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
