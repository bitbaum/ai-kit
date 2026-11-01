/**
 * An MCP client, the way a product's bots reach a connector.
 *
 * WHY THIS IS IN THIS PACKAGE
 *
 * The fleet's products already SERVE MCP (OrangeCat's and Loki's `/api/mcp`),
 * and the next thing every one of them wants is to CALL one: a bot on
 * OrangeCat asking Loki as the person, a product reaching a vendor's server
 * with the person's token. Each would write the same forty lines of
 * JSON-RPC over Streamable HTTP, and each would get one of the two
 * response shapes wrong (a server may answer a POST with JSON or with an
 * SSE stream, and the spec allows either per request). So the client lives
 * here, once, and hands tools back in the shape `complete()` already takes.
 *
 * Scope, on purpose: Streamable HTTP only (the transport every hosted server
 * speaks), a bearer token the caller already holds, `tools/list` and
 * `tools/call`. No OAuth flow (that is the product's, with its own consent
 * screen), no stdio, no resources or prompts until a caller needs them.
 * Web APIs only — no Node, no framework.
 */

import { readEventStream } from "./sse.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** A tool as an MCP server lists it. */
export interface McpTool {
  name: string;
  description?: string;
  /** JSON Schema for the arguments, as the server published it. */
  inputSchema: Record<string, unknown>;
}

/** What a tool call came back with. */
export interface McpToolResult {
  /** The text parts joined, in order; empty when the server sent none. */
  text: string;
  /** Every content part as sent (text, image, resource…), untouched. */
  content: unknown[];
  isError: boolean;
  /** Structured output, when the server returned one. */
  structured?: unknown;
}

export interface McpClientOptions {
  /** The server's Streamable HTTP endpoint, e.g. https://loki.orangecat.ch/api/mcp */
  url: string;
  /** Sent as `Authorization: Bearer …`. */
  token?: string;
  /** Extra headers, for a server that wants more than a bearer. */
  headers?: Record<string, string>;
  clientInfo?: { name: string; version: string };
  fetchImpl?: typeof fetch;
  /** Per request; the default is generous because a tool may do real work. */
  timeoutMs?: number;
}

/** The server said no, in JSON-RPC's words. */
export class McpError extends Error {
  constructor(
    message: string,
    readonly code: number | string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpError";
  }
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * One connection to one server: `initialize` once, then as many `tools/list`
 * and `tools/call` as the caller needs. A session id the server hands back
 * on initialize rides every later request, as the transport asks.
 */
export class McpClient {
  private sessionId: string | null = null;
  private initialized: Promise<void> | null = null;
  private nextId = 1;

  constructor(private readonly options: McpClientOptions) {}

  /** The tools the server lists, as the server lists them. */
  async listTools(): Promise<McpTool[]> {
    await this.ensureInitialized();
    const result = (await this.request("tools/list", {})) as { tools?: unknown[] } | undefined;
    const raw = Array.isArray(result?.tools) ? result.tools : [];
    return raw
      .map((t) => t as Partial<McpTool>)
      .filter((t): t is McpTool => typeof t.name === "string" && t.name.length > 0)
      .map((t) => ({
        name: t.name,
        ...(typeof t.description === "string" ? { description: t.description } : {}),
        inputSchema:
          t.inputSchema && typeof t.inputSchema === "object"
            ? (t.inputSchema as Record<string, unknown>)
            : { type: "object", properties: {} },
      }));
  }

  /** Call one tool. A server-side tool error comes back as `isError`, never a throw. */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    await this.ensureInitialized();
    const result = (await this.request("tools/call", { name, arguments: args })) as
      { content?: unknown[]; isError?: boolean; structuredContent?: unknown } | undefined;
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content
      .map((part) => {
        const p = part as { type?: string; text?: unknown };
        return p?.type === "text" && typeof p.text === "string" ? p.text : "";
      })
      .filter(Boolean)
      .join("\n");
    return {
      text,
      content,
      isError: result?.isError === true,
      ...(result?.structuredContent !== undefined ? { structured: result.structuredContent } : {}),
    };
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        await this.request("initialize", {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: this.options.clientInfo ?? { name: "@bitbaum/ai-kit", version: "mcp" },
        });
        await this.notify("notifications/initialized");
      })().catch((error: unknown) => {
        // A failed handshake is not a session: the next call tries again.
        this.initialized = null;
        throw error;
      });
    }
    return this.initialized;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      ...(this.options.headers ?? {}),
    };
  }

  private async post(body: unknown): Promise<Response> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000);
    try {
      const res = await fetchImpl(this.options.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const session = res.headers.get("mcp-session-id");
      if (session) this.sessionId = session;
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  private async notify(method: string): Promise<void> {
    const res = await this.post({ jsonrpc: "2.0", method });
    // 202 is the transport's answer to a notification; anything else is read for an error.
    if (!res.ok && res.status !== 202) {
      throw new McpError(`${method} failed with HTTP ${res.status}`, res.status);
    }
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, params });
    if (!res.ok) {
      throw new McpError(
        `${method} failed with HTTP ${res.status}`,
        res.status,
        await safeText(res),
      );
    }
    const message = await readResponse(res, id);
    if (!message) {
      throw new McpError(`${method}: the server sent no response for request ${id}`, "no_response");
    }
    if (message.error) {
      throw new McpError(message.error.message, message.error.code, message.error.data);
    }
    return message.result;
  }
}

/**
 * The response for one request id, whether the server answered with a JSON
 * body or with an SSE stream (the transport allows either per request; a
 * stream may carry notifications before the response, which are skipped).
 */
async function readResponse(res: Response, id: number): Promise<JsonRpcResponse | null> {
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream") && res.body) {
    let found: JsonRpcResponse | null = null;
    await readEventStream<unknown>(res.body, (event) => {
      const message = event as JsonRpcResponse;
      if (message && typeof message === "object" && message.id === id) found = message;
    });
    return found;
  }
  const text = await res.text();
  if (!text.trim()) return null;
  const parsed: unknown = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return (list as JsonRpcResponse[]).find((m) => m && typeof m === "object" && m.id === id) ?? null;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}

/**
 * MCP tools in the shape `complete()` takes (OpenAI-style function tools),
 * so a server's tools can be offered to a model with no translation table:
 * the tool name is the MCP name, and a call comes back as a `ToolCall` whose
 * `name` is what `callTool` wants.
 */
export function toolDefinitionsFrom(tools: readonly McpTool[]): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.inputSchema,
    },
  }));
}

/** One client, memoised per url and token, for callers that reach a server per request. */
export function mcpClient(options: McpClientOptions): McpClient {
  return new McpClient(options);
}
