import { fileURLToPath } from "node:url";

export const LLM_PORT = 18080;
export const EGRESS_PORT = 18081;
export const CONTAINER_SOCKET_DIR = "/run/matrix";
export const CONTAINER_BRIDGE = "/opt/matrix/bridge.mjs";
export const READY_FILE = "/tmp/.matrix-bridge-ready";
/** Put this in a runner's gateway apiKey; the sandbox swaps in the per-run token minted at launch. */
export const RUN_TOKEN_PLACEHOLDER = "__MATRIX_RUN_TOKEN__";

export function fillRunToken(value: string, token: string): string {
  return value.split(RUN_TOKEN_PLACEHOLDER).join(token);
}

export const BRIDGE_ASSET = fileURLToPath(new URL("../assets/bridge.mjs", import.meta.url));

/** Env a sandboxed process sees for the network it was granted. Contains the run token, never a real key. */
export function sandboxNetworkEnv(
  network: "none" | "gateway" | "allowlist",
): Record<string, string> {
  const env: Record<string, string> = {};
  if (network === "none") return env;
  env.MATRIX_LLM_URL = `http://127.0.0.1:${LLM_PORT}`;
  if (network === "allowlist") {
    const proxy = `http://127.0.0.1:${EGRESS_PORT}`;
    Object.assign(env, {
      HTTPS_PROXY: proxy,
      https_proxy: proxy,
      HTTP_PROXY: proxy,
      http_proxy: proxy,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    });
  }
  return env;
}

/**
 * Wraps a command so the loopback bridge starts first and the real command runs once it is ready.
 * Without sockets there is nothing to bridge and the command runs directly.
 */
export function withBridge(
  cmd: string[],
  bridged: boolean,
  nodeBinary = "node",
  bridgePath = CONTAINER_BRIDGE,
): string[] {
  if (!bridged) return cmd;
  const script = [
    `${nodeBinary} ${bridgePath} >/dev/null 2>&1 &`,
    "i=0",
    `while [ ! -e ${READY_FILE} ]; do i=$((i+1)); [ $i -gt 200 ] && echo 'matrix bridge did not start' >&2 && exit 97; sleep 0.05; done`,
    'exec "$@"',
  ].join("\n");
  return ["sh", "-c", script, "matrix-sandbox", ...cmd];
}

/** Rewrites host paths under `from` into the sandbox path `to` (cwd, args, env values). */
export function mapPath(value: string, from: string, to: string): string {
  if (value === from) return to;
  if (value.startsWith(`${from}/`)) return `${to}${value.slice(from.length)}`;
  return value;
}

export function assertEnvName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid env var name: ${name}`);
}
