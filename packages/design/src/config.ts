import { contentHash, type FigmaMcpCapability, figmaConfigurationHash } from "@matrix/core";
import { z } from "zod";

const identifier = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
export const httpsEndpoint = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !url.port &&
      !/^(localhost|.*\.localhost|.*\.local|\[.*\]|[\d.]+)$/i.test(url.hostname)
    );
  });
const toolBinding = z
  .object({
    name: identifier,
    fileArgument: identifier,
    nodeArgument: identifier,
    arguments: z
      .record(identifier, z.union([z.string().max(1000), z.number().finite(), z.boolean()]))
      .default({}),
  })
  .strict()
  .refine(
    (binding) =>
      binding.fileArgument !== binding.nodeArgument &&
      !(binding.fileArgument in binding.arguments) &&
      !(binding.nodeArgument in binding.arguments),
  );
export const operatorConfigSchema = z
  .object({
    serverName: identifier,
    endpoint: httpsEndpoint,
    credentialRef: z.string().min(1).max(256),
    authMode: z.enum(["credential-store", "oauth", "connected-sdk-client"]),
    oauthOrigins: z
      .array(httpsEndpoint.refine((value) => new URL(value).origin === value))
      .max(10)
      .default([]),
    fileKey: z.string().regex(/^[a-zA-Z0-9]+$/),
    nodes: z
      .array(z.string().regex(/^\d+:\d+$/))
      .min(1)
      .max(100)
      .refine((nodes) => new Set(nodes).size === nodes.length),
    authenticationTool: z
      .object({
        name: identifier,
        arguments: z.record(identifier, z.string().max(1000)).default({}),
        identityPath: z.array(identifier).min(1).max(5),
      })
      .strict(),
    contextTool: toolBinding,
    screenshotTool: toolBinding,
    downloadOrigins: z
      .array(httpsEndpoint.refine((value) => new URL(value).origin === value))
      .max(10),
    pixelThreshold: z.number().min(0).max(0.5).default(0.1),
    maxDiffPixelRatio: z.number().min(0).max(0.1).default(0),
  })
  .strict()
  .refine(
    (config) =>
      new Set([config.authenticationTool.name, config.contextTool.name, config.screenshotTool.name])
        .size === 3,
  );
export type OperatorConfig = z.input<typeof operatorConfigSchema>;
export type ParsedConfig = z.output<typeof operatorConfigSchema>;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function capabilityFor(
  config: OperatorConfig,
  discoverySha256?: string,
): FigmaMcpCapability {
  const parsed = operatorConfigSchema.parse(config);
  const policySha256 = contentHash(
    Buffer.from(
      canonicalJson({
        ...parsed,
        nodes: [...parsed.nodes].sort(),
        downloadOrigins: [...parsed.downloadOrigins].sort(),
        ...(discoverySha256 ? { discoverySha256 } : {}),
      }),
    ),
  );
  const capability = { serverName: parsed.serverName, url: parsed.endpoint, policySha256 };
  return Object.freeze({ ...capability, configurationSha256: figmaConfigurationHash(capability) });
}
