import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type AdapterDependencies, discover, FigmaMcpAdapter } from "./adapter.js";
import { type OperatorConfig, operatorConfigSchema } from "./config.js";
import { credentialFromStore } from "./storage.js";

export type ExplicitAuthorization = {
  operatorAuthorized: true;
  origin: string;
  credentialRef: string;
} & (
  | { kind: "credential-store"; root: string }
  | { kind: "oauth"; provider: OAuthClientProvider; authorizationOrigins: string[] }
  | { kind: "connected-sdk-client"; client: Client }
);
export function restrictedMcpFetch(
  endpoint: string,
  origins: string[],
  fetcher: typeof fetch,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    if (
      !origins.includes(url.origin) ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      headers.has("cookie") ||
      headers.has("proxy-authorization") ||
      (headers.has("authorization") && url.href !== endpoint)
    )
      throw new Error("MCP request origin/credential forwarding denied");
    const response = await fetcher(input, {
      ...init,
      headers,
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(15000)]),
    });
    if (
      response.redirected ||
      (response.url && !origins.includes(new URL(response.url).origin)) ||
      Number(response.headers.get("content-length") ?? 0) > 32 * 1024 * 1024
    )
      throw new Error("MCP response origin/size denied");
    if (!response.body) return response;
    let size = 0;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          size += chunk.byteLength;
          if (size > 32 * 1024 * 1024) throw new Error("MCP response size limit exceeded");
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
export async function createFigmaDesignAdapter(options: {
  config: OperatorConfig;
  authorization: ExplicitAuthorization;
  dependencies: AdapterDependencies;
  transportFetch?: typeof fetch;
}) {
  const config = operatorConfigSchema.parse(options.config);
  const authorization = options.authorization;
  if (
    authorization.operatorAuthorized !== true ||
    authorization.kind !== config.authMode ||
    authorization.origin !== new URL(config.endpoint).origin ||
    authorization.credentialRef !== config.credentialRef
  )
    throw new Error("explicit origin-bound operator authorization required");
  let client: Client;
  let owned = false;
  if (authorization.kind === "connected-sdk-client") client = authorization.client;
  else {
    client = new Client({ name: "matrix-host-design", version: "1.0.0" }, { capabilities: {} });
    owned = true;
    const origins = [authorization.origin];
    if (authorization.kind === "oauth") {
      if (
        JSON.stringify([...authorization.authorizationOrigins].sort()) !==
        JSON.stringify([...config.oauthOrigins].sort())
      )
        throw new Error("OAuth origin policy differs from bound configuration");
      for (const origin of authorization.authorizationOrigins) {
        const parsed = new URL(origin);
        if (
          parsed.protocol !== "https:" ||
          parsed.origin !== origin ||
          parsed.username ||
          parsed.password
        )
          throw new Error("invalid authorized OAuth origin");
        origins.push(origin);
      }
    }
    const token =
      authorization.kind === "credential-store"
        ? await credentialFromStore(authorization.root, authorization.credentialRef)
        : undefined;
    const guardedFetch = restrictedMcpFetch(
      config.endpoint,
      origins,
      options.transportFetch ?? fetch,
    );
    const transport = new StreamableHTTPClientTransport(new URL(config.endpoint), {
      fetch: guardedFetch,
      redirectPolicy: "same-origin",
      requestInit: {
        redirect: "error",
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      },
      ...(authorization.kind === "oauth" ? { authProvider: authorization.provider } : {}),
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
    });
    try {
      await client.connect(transport as Transport);
    } catch {
      await client.close().catch(() => {});
      throw new Error("Figma MCP connection blocked; operator authorization required");
    }
  }
  try {
    const tools = await discover(client, config);
    const figma = new FigmaMcpAdapter(client, config, options.dependencies, tools);
    return {
      figma,
      capability: figma.capability,
      runnerMcp: {
        serverName: figma.capability.serverName,
        url: figma.capability.url,
        policySha256: figma.capability.policySha256!,
        hostCaptureOnly: true as const,
      },
      close: async () => {
        if (owned) await client.close();
      },
    };
  } catch {
    if (owned) await client.close().catch(() => {});
    throw new Error("Figma MCP authenticated tool discovery blocked");
  }
}
