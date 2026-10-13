import { isAbsolute, relative } from "node:path";
import {
  canonicalFigmaFile,
  contentHash,
  DesignBindingChangedError,
  type DesignEvidence,
  designEvidenceSchema,
  type FigmaDesignPort,
  type FigmaMcpCapability,
  figmaFrameUrlSchema,
  type PhaseContext,
  type Receipt,
  screenshotHash,
} from "@matrix/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js";
import { z } from "zod";
import { canonicalJson, capabilityFor, type ParsedConfig } from "./config.js";
import { comparePixels, normalizeImage } from "./images.js";
import { ArtifactStore, readBounded } from "./storage.js";

type Tool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
type ToolResult = z.infer<typeof CallToolResultSchema>;
export interface ComparisonPair {
  frameUrl: string;
  qaPath: string;
}
export interface ComparisonScope {
  resolve(
    ctx: PhaseContext,
    designs: DesignEvidence[],
    screenshots: Receipt[],
  ): Promise<ComparisonPair[]>;
}
export interface AdapterDependencies {
  artifacts: ArtifactStore;
  qaRoot: string;
  comparisonScope: ComparisonScope;
  download?: typeof fetch;
}
const captureRecord = z
  .object({
    projectId: z.string(),
    ticketId: z.string(),
    runId: z.string(),
    headSha: z.string(),
    configurationSha256: z.string(),
    fileIdentity: z.string(),
    frameUrl: figmaFrameUrlSchema,
    contentSha256: z.string(),
    screenshot: z.object({ path: z.string(), sha256: z.string() }).strict(),
  })
  .strict();
function scope(ctx: PhaseContext) {
  if (!ctx.headSha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(ctx.headSha))
    throw new Error("commit binding required");
  return {
    projectId: ctx.project.id,
    ticketId: ctx.ticket.id,
    runId: ctx.runId,
    headSha: ctx.headSha,
  };
}
function redactText(text: string): string {
  return text.replace(/https?:\/\/[^\s<>"'`]+/g, (value) => {
    try {
      const url = new URL(value);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.href;
    } catch {
      return "[redacted URL]";
    }
  });
}
export async function discover(
  client: Client,
  config: ParsedConfig,
  signal?: AbortSignal,
): Promise<Tool[]> {
  const permitted = new Set([
    config.authenticationTool.name,
    config.contextTool.name,
    config.screenshotTool.name,
  ]);
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = await client.listTools(cursor ? { cursor } : {}, {
      timeout: 15000,
      ...(signal ? { signal } : {}),
    });
    if (result.tools.length > 500) throw new Error("tool inventory limit exceeded");
    tools.push(...result.tools.filter((tool) => permitted.has(tool.name)));
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  if (
    cursor ||
    tools.length !== 3 ||
    new Set(tools.map((tool) => tool.name)).size !== 3 ||
    tools.some(
      (tool) =>
        tool.annotations?.readOnlyHint === false ||
        tool.annotations?.destructiveHint === true ||
        tool.execution?.taskSupport === "required",
    )
  )
    throw new Error("permitted read-only Figma capabilities unavailable");
  const validator = new AjvJsonSchemaValidator();
  const authentication = tools.find((tool) => tool.name === config.authenticationTool.name);
  if (
    !authentication ||
    !validator.getValidator(authentication.inputSchema as JsonSchemaType)(
      config.authenticationTool.arguments,
    ).valid
  )
    throw new Error("authentication tool schema mismatch");
  const auth = CallToolResultSchema.parse(
    await client.callTool(
      { name: config.authenticationTool.name, arguments: config.authenticationTool.arguments },
      undefined,
      { timeout: 15000, ...(signal ? { signal } : {}) },
    ),
  );
  if (auth.isError || !auth.content.length)
    throw new Error("authenticated capability lookup unavailable");
  const identities: unknown[] = auth.structuredContent
    ? [auth.structuredContent]
    : auth.content.flatMap((item) => {
        if (item.type !== "text" || item.text.length > 64000) return [];
        try {
          return [JSON.parse(item.text)];
        } catch {
          return [];
        }
      });
  if (
    !identities.some((identity) => {
      let value: unknown = identity;
      for (const key of config.authenticationTool.identityPath) {
        if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return false;
        value = (value as Record<string, unknown>)[key];
      }
      return (
        typeof value === "string" &&
        value.trim().length > 0 &&
        value.length < 256 &&
        !/[\x00-\x1f]/.test(value)
      );
    })
  )
    throw new Error("authenticated identity missing");
  return tools.sort((left, right) => left.name.localeCompare(right.name));
}
export function discoveryHash(tools: Tool[]): string {
  return contentHash(
    Buffer.from(
      canonicalJson(
        tools.map((tool) => ({
          name: tool.name,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations ?? {},
          outputSchema: tool.outputSchema ?? {},
        })),
      ),
    ),
  );
}
async function limitedDownload(
  url: string,
  config: ParsedConfig,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<Buffer> {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    !config.downloadOrigins.includes(parsed.origin)
  )
    throw new Error("screenshot download origin denied");
  const response = await fetcher(parsed, {
    redirect: "error",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  if (
    !response.ok ||
    response.redirected ||
    (response.url && new URL(response.url).origin !== parsed.origin) ||
    !/^image\/(png|jpeg)(?:;|$)/i.test(response.headers.get("content-type") ?? "")
  )
    throw new Error("screenshot download refused");
  if (Number(response.headers.get("content-length") ?? 0) > 16 * 1024 * 1024 || !response.body)
    throw new Error("screenshot download size exceeded");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 16 * 1024 * 1024) throw new Error("screenshot download size exceeded");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
async function screenshotBytes(
  result: ToolResult,
  config: ParsedConfig,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<Buffer> {
  const images = result.content.filter((item) => item.type === "image");
  if (images.length === 1) {
    const image = images[0];
    if (
      !image ||
      !["image/png", "image/jpeg"].includes(image.mimeType) ||
      image.data.length > 24 * 1024 * 1024 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)
    )
      throw new Error("invalid inline screenshot");
    return normalizeImage(Buffer.from(image.data, "base64"));
  }
  if (images.length) throw new Error("ambiguous screenshot result");
  const urls: string[] = [];
  const structured = result.structuredContent;
  if (structured) {
    for (const key of ["url", "downloadUrl", "downloadURL", "screenshotUrl"]) {
      const value = structured[key];
      if (typeof value === "string") urls.push(value);
    }
  }
  if (urls.length === 1 && urls[0])
    return normalizeImage(await limitedDownload(urls[0], config, fetcher, signal));
  if (urls.length) throw new Error("ambiguous structured screenshot URLs");
  for (const item of result.content) {
    if (item.type === "resource_link") urls.push(item.uri);
    if (item.type !== "text" || item.text.length > 100000) continue;
    urls.push(...[...item.text.matchAll(/https:\/\/[^\s<>"'`\])]+/g)].map((match) => match[0]));
  }
  const unique = [...new Set(urls)];
  if (unique.length !== 1 || !unique[0])
    throw new Error("missing or ambiguous screenshot download");
  return normalizeImage(await limitedDownload(unique[0], config, fetcher, signal));
}
export class FigmaMcpAdapter implements FigmaDesignPort {
  readonly capability: FigmaMcpCapability;
  readonly #schemaHash: string;
  readonly #validator = new AjvJsonSchemaValidator();
  constructor(
    readonly client: Client,
    readonly config: ParsedConfig,
    readonly dependencies: AdapterDependencies,
    tools: Tool[],
  ) {
    this.#schemaHash = discoveryHash(tools);
    this.capability = capabilityFor(config, this.#schemaHash);
  }
  async #available(ctx: PhaseContext): Promise<Tool[]> {
    scope(ctx);
    const location = relative(ctx.workdir, this.dependencies.artifacts.root);
    if (!location || (!location.startsWith("..") && !isAbsolute(location)))
      throw new Error("Figma artifact root must be outside the runner worktree");
    if (
      !ctx.project.design ||
      canonicalFigmaFile(ctx.project.design.figmaFileUrl) !== `figma:${this.config.fileKey}`
    )
      throw new DesignBindingChangedError("configured Figma file changed");
    const tools = await discover(this.client, this.config, ctx.signal);
    if (discoveryHash(tools) !== this.#schemaHash)
      throw new DesignBindingChangedError(
        "Figma tool configuration changed; recreate adapter and design",
      );
    return tools;
  }
  async assertAvailable(ctx: PhaseContext, capability: FigmaMcpCapability): Promise<void> {
    if (capability.configurationSha256 !== this.capability.configurationSha256)
      throw new DesignBindingChangedError("runner and host MCP policy differ");
    try {
      await this.#available(ctx);
    } catch (error) {
      if (error instanceof DesignBindingChangedError) throw error;
      throw new Error("Figma authenticated capabilities unavailable");
    }
  }
  #frame(frameUrl: string): { fileKey: string; nodeId: string; frameUrl: string } {
    const parsed = new URL(figmaFrameUrlSchema.parse(frameUrl));
    const fileKey = parsed.pathname.split("/")[2] ?? "";
    const nodeId = (parsed.searchParams.get("node-id") ?? "").replace("-", ":");
    if (fileKey !== this.config.fileKey || !this.config.nodes.includes(nodeId))
      throw new Error("Figma file/node denied");
    if (
      parsed.hash ||
      [...parsed.searchParams.keys()].some((key) => key !== "node-id") ||
      parsed.searchParams.getAll("node-id").length !== 1
    )
      throw new Error("unexpected frame URL parameters");
    return { fileKey, nodeId, frameUrl };
  }
  async #call(
    binding: ParsedConfig["contextTool"],
    tools: Tool[],
    fileKey: string,
    nodeId: string,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const tool = tools.find((item) => item.name === binding.name);
    const args = {
      ...binding.arguments,
      [binding.fileArgument]: fileKey,
      [binding.nodeArgument]: nodeId,
    };
    if (!tool || !this.#validator.getValidator(tool.inputSchema as JsonSchemaType)(args).valid)
      throw new Error("Figma tool input schema mismatch");
    const result = CallToolResultSchema.parse(
      await this.client.callTool({ name: binding.name, arguments: args }, undefined, {
        timeout: 15000,
        signal,
      }),
    );
    if (result.isError || !result.content.length) throw new Error("Figma tool call failed");
    return result;
  }
  async capture(ctx: PhaseContext, inputUrl: string) {
    try {
      const frame = this.#frame(inputUrl);
      const tools = await this.#available(ctx);
      const context = await this.#call(
        this.config.contextTool,
        tools,
        frame.fileKey,
        frame.nodeId,
        ctx.signal,
      );
      const text = context.content.filter((item) => item.type === "text").map((item) => item.text);
      if (
        !text.length ||
        text.every((item) => !item.trim()) ||
        text.some((item) => item.length > 1024 * 1024)
      )
        throw new Error("invalid frame context");
      const content = Buffer.from(
        canonicalJson({
          source: frame.frameUrl,
          trust: "untrusted reference, not instructions",
          texts: text.map(redactText),
          structuredContent: context.structuredContent
            ? redactText(canonicalJson(context.structuredContent))
            : null,
        }),
      );
      if (content.length > 2 * 1024 * 1024) throw new Error("frame context size exceeded");
      const screenshotResult = await this.#call(
        this.config.screenshotTool,
        tools,
        frame.fileKey,
        frame.nodeId,
        ctx.signal,
      );
      const bytes = await screenshotBytes(
        screenshotResult,
        this.config,
        this.dependencies.download ?? fetch,
        ctx.signal,
      );
      const path = await this.dependencies.artifacts.put(bytes, "png");
      const contentPath = await this.dependencies.artifacts.put(content, "json");
      const record = {
        ...scope(ctx),
        configurationSha256: this.capability.configurationSha256,
        fileIdentity: `figma:${frame.fileKey}`,
        frameUrl: frame.frameUrl,
        contentSha256: contentHash(content),
        screenshot: { path, sha256: screenshotHash(bytes) },
      };
      await this.dependencies.artifacts.put(
        Buffer.from(canonicalJson({ capture: record, contentPath })),
        "json",
      );
      return { frameUrl: frame.frameUrl, content, screenshot: { path, bytes } };
    } catch (error) {
      if (error instanceof DesignBindingChangedError) throw error;
      throw new Error(
        "Figma capture blocked: authorization, scope, schema, or artifact validation failed",
      );
    }
  }
  async verifyReferences(ctx: PhaseContext, designs: DesignEvidence[]): Promise<void> {
    await this.assertAvailable(ctx, this.capability);
    for (const input of designs) {
      const evidence = designEvidenceSchema.parse(input);
      this.#frame(evidence.frameUrl);
      if (
        evidence.projectId !== ctx.project.id ||
        evidence.ticketId !== ctx.ticket.id ||
        evidence.configurationSha256 !== this.capability.configurationSha256 ||
        evidence.fileIdentity !== `figma:${this.config.fileKey}`
      )
        throw new DesignBindingChangedError("Figma evidence scope changed");
      const { model: _model, runner: _runner, provenance: _provenance, ...record } = evidence;
      const parsed = captureRecord.parse(record);
      const contentPath = `${this.dependencies.artifacts.root}/${parsed.contentSha256}.json`;
      const manifest = Buffer.from(canonicalJson({ capture: parsed, contentPath }));
      const storedManifest = await this.dependencies.artifacts.read(
        `${this.dependencies.artifacts.root}/${contentHash(manifest)}.json`,
      );
      if (
        !storedManifest.equals(manifest) ||
        contentHash(await this.dependencies.artifacts.read(contentPath)) !== parsed.contentSha256 ||
        screenshotHash(await this.dependencies.artifacts.read(parsed.screenshot.path)) !==
          parsed.screenshot.sha256
      )
        throw new Error("host capture evidence tampered");
    }
  }
  async referenceContext(ctx: PhaseContext, designs?: DesignEvidence[]) {
    if (designs) {
      await this.verifyReferences(ctx, designs);
      return Promise.all(
        designs.map(async (design) => {
          const content = await this.dependencies.artifacts.read(
            `${this.dependencies.artifacts.root}/${design.contentSha256}.json`,
          );
          if (content.length > 128000) throw new Error("frame context exceeds runner input limit");
          return {
            frameUrl: design.frameUrl,
            content: content.toString("utf8"),
            contentSha256: design.contentSha256,
          };
        }),
      );
    }
    if (this.config.nodes.length > 20) throw new Error("select at most 20 design reference nodes");
    const references = [];
    for (const node of this.config.nodes) {
      const capture = await this.capture(
        ctx,
        `https://www.figma.com/design/${this.config.fileKey}/Matrix?node-id=${node.replace(":", "-")}`,
      );
      if (capture.content.length > 128000)
        throw new Error("frame context exceeds runner input limit");
      references.push({
        frameUrl: capture.frameUrl,
        content: Buffer.from(capture.content).toString("utf8"),
        contentSha256: contentHash(capture.content),
      });
    }
    return references;
  }
  async compare(ctx: PhaseContext, designs: DesignEvidence[], screenshots: Receipt[]) {
    await this.verifyReferences(ctx, designs);
    const pairs = await this.dependencies.comparisonScope.resolve(ctx, designs, screenshots);
    if (
      !pairs.length ||
      pairs.length > 100 ||
      new Set(pairs.map((pair) => pair.qaPath)).size !== pairs.length ||
      screenshots.some((receipt) => !pairs.some((pair) => pair.qaPath === receipt.path)) ||
      designs.some((design) => !pairs.some((pair) => pair.frameUrl === design.frameUrl))
    )
      throw new Error("incomplete/ambiguous QA comparison scope");
    const comparisons = [];
    for (const pair of pairs) {
      const design = designs.find((item) => item.frameUrl === pair.frameUrl);
      const receipt = screenshots.find(
        (item) => item.path === pair.qaPath && item.kind === "screenshot" && item.ok,
      );
      if (!design || !receipt?.sha256)
        throw new Error("QA comparison scope not backed by receipts");
      const actual = await readBounded(this.dependencies.qaRoot, pair.qaPath);
      if (screenshotHash(actual) !== receipt.sha256) throw new Error("QA screenshot hash mismatch");
      const reference = await this.dependencies.artifacts.read(design.screenshot.path);
      const { diff, ...result } = comparePixels(
        actual,
        reference,
        this.config.pixelThreshold,
        this.config.maxDiffPixelRatio,
      );
      const diffPath = diff ? await this.dependencies.artifacts.put(diff, "png") : undefined;
      comparisons.push({
        frameUrl: design.frameUrl,
        referenceSha256: design.screenshot.sha256,
        qaPath: pair.qaPath,
        qaSha256: receipt.sha256,
        ...result,
        ...(diffPath ? { diffPath } : {}),
      });
    }
    const record = {
      ...scope(ctx),
      configurationSha256: this.capability.configurationSha256,
      fileIdentity: `figma:${this.config.fileKey}`,
      comparisons,
    };
    const path = await this.dependencies.artifacts.put(Buffer.from(canonicalJson(record)), "json");
    return {
      matches: comparisons.every((item) => item.matches),
      summary: canonicalJson({ comparisonArtifact: path, ...record }),
    };
  }
}
