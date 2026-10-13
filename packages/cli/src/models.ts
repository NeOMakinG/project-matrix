import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { modelsConfig } from "@matrix/config";
import { parseJsonc } from "./orca/config-edit";
import { assertSafeTransport } from "./orca/mcp";

export const MODELS_USAGE =
  "matrix models check --gateway <url> [--config <matrix.config.ts|json>]\n  Lists logical -> resolved model IDs and checks GET /v1/models only; never runs inference.\n  Optional bearer credential: MATRIX_GATEWAY_TOKEN in a protected environment file.";

export function configuredModels(text: string): Array<{ logical: string; resolved: string }> {
  const literal =
    text.match(
      /const\s+config\s*=\s*(\{[\s\S]*\})\s*as\s+const;\s*export\s+default\s+config;?\s*$/,
    )?.[1] ??
    text.match(/export\s+default\s+defineConfig\s*\(\s*(\{[\s\S]*\})\s*\);?\s*$/)?.[1] ??
    text;
  const config = parseJsonc("model config", literal) as { models?: unknown };
  if (!config.models) throw new Error("config has no model plan");
  const models = modelsConfig.parse(config.models);
  const ids = new Set<string>();
  for (const [name, value] of Object.entries(models)) {
    if (name === "tiers") {
      if (models.tiers) for (const tier of Object.values(models.tiers)) ids.add(tier.model);
    } else if (
      value &&
      typeof value === "object" &&
      "model" in value &&
      typeof value.model === "string"
    )
      ids.add(value.model);
  }
  for (const id of Object.keys(models.aliases)) ids.add(id);
  return [...ids]
    .sort()
    .map((logical) => ({ logical, resolved: models.aliases[logical] ?? logical }));
}

export async function modelsCommand(
  argv: string[],
  options: {
    fetchImpl?: typeof fetch;
    readConfig?: (file: string) => Promise<string>;
    write?: (text: string) => void;
    token?: string;
  } = {},
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      gateway: { type: "string" },
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const write = options.write ?? console.log;
  if (values.help) {
    write(MODELS_USAGE);
    return 0;
  }
  if (positionals.length !== 1 || positionals[0] !== "check" || !values.gateway)
    throw new Error(MODELS_USAGE);
  const configured = configuredModels(
    await (options.readConfig ?? ((file) => readFile(file, "utf8")))(
      values.config ?? "matrix.config.ts",
    ),
  );
  const url = new URL(values.gateway);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("gateway must be an HTTP(S) base URL without credentials, query or fragment");
  const token = options.token ?? process.env.MATRIX_GATEWAY_TOKEN;
  if (token) assertSafeTransport(url.toString(), false);
  url.pathname = `${url.pathname.replace(/\/$/, "").replace(/\/v1$/, "")}/v1/models`;
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
  if (!response.ok) throw new Error(`gateway model listing failed: HTTP ${response.status}`);
  const body = (await response.json()) as { data?: Array<{ id?: string }> };
  if (!Array.isArray(body.data) || body.data.some((item) => typeof item?.id !== "string"))
    throw new Error("invalid gateway model listing");
  const available = new Set(body.data.map((item) => item.id));
  for (const { logical, resolved } of configured)
    write(`${logical} -> ${resolved}: ${available.has(resolved) ? "available" : "MISSING"}`);
  return configured.every(({ resolved }) => available.has(resolved)) ? 0 : 2;
}
