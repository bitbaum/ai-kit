/**
 * The MCP client against a fake server: the handshake once, the session id
 * carried, tools in `complete()`'s shape, a call's text joined, a tool error
 * as data, a JSON-RPC error as a throw, and the SSE answer shape read the
 * same as the JSON one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { McpClient, McpError, toolDefinitionsFrom } from "../dist/mcp.js";

function fakeServer({ sse = false } = {}) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    seen.push({ headers: req.headers, body });
    const reply = (payload) => {
      if (sse) {
        res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "s-1" });
        res.end(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\n` +
            `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      } else {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s-1" });
        res.end(JSON.stringify(payload));
      }
    };
    if (body.method === "notifications/initialized") return res.writeHead(202).end();
    if (body.method === "initialize")
      return reply({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } });
    if (body.method === "tools/list")
      return reply({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [
            {
              name: "ask_loki",
              description: "Ask Loki",
              inputSchema: { type: "object", properties: { message: { type: "string" } } },
            },
            { name: "nameless-but-fine" },
            { description: "no name, dropped" },
          ],
        },
      });
    if (body.method === "tools/call") {
      if (body.params.name === "boom")
        return reply({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "bad args" } });
      if (body.params.name === "soft")
        return reply({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: "nope" }], isError: true },
        });
      return reply({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [
            { type: "text", text: `you said ${body.params.arguments.message}` },
            { type: "image", data: "…" },
            { type: "text", text: "second line" },
          ],
          structuredContent: { ok: true },
        },
      });
    }
    res.writeHead(404).end();
  });
  await_listen(server);
  return { server, seen, url: () => `http://127.0.0.1:${server.address().port}/mcp` };
}
function await_listen(server) {
  server.listen(0);
}

for (const sse of [false, true]) {
  test(`${sse ? "SSE" : "JSON"} answers: handshake once, tools, call, errors`, async () => {
    const { server, seen, url } = fakeServer({ sse });
    await new Promise((r) => server.once("listening", r));
    try {
      const client = new McpClient({
        url: url(),
        token: "tok",
        clientInfo: { name: "t", version: "1" },
      });
      const tools = await client.listTools();
      assert.deepEqual(
        tools.map((t) => t.name),
        ["ask_loki", "nameless-but-fine"],
      );
      assert.deepEqual(tools[1].inputSchema, { type: "object", properties: {} });
      const defs = toolDefinitionsFrom(tools);
      assert.equal(defs[0].type, "function");
      assert.equal(defs[0].function.name, "ask_loki");
      assert.equal(defs[0].function.parameters.properties.message.type, "string");

      const out = await client.callTool("ask_loki", { message: "hi" });
      assert.equal(out.text, "you said hi\nsecond line");
      assert.equal(out.isError, false);
      assert.equal(out.content.length, 3);
      assert.deepEqual(out.structured, { ok: true });

      const soft = await client.callTool("soft");
      assert.equal(soft.isError, true);
      assert.equal(soft.text, "nope");

      await assert.rejects(
        () => client.callTool("boom"),
        (e) => e instanceof McpError && e.code === -32602 && /bad args/.test(e.message),
      );

      const methods = seen.map((s) => s.body.method);
      assert.deepEqual(methods.slice(0, 2), ["initialize", "notifications/initialized"]);
      assert.equal(methods.filter((m) => m === "initialize").length, 1, "one handshake");
      assert.equal(seen[0].headers.authorization, "Bearer tok");
      assert.equal(seen[0].headers["mcp-protocol-version"], "2025-06-18");
      assert.equal(
        seen.at(-1).headers["mcp-session-id"],
        "s-1",
        "the session id rides later requests",
      );
    } finally {
      server.close();
    }
  });
}

test("an HTTP failure is an McpError with the status", async () => {
  const server = createServer((req, res) =>
    res.writeHead(401, { "www-authenticate": "Bearer" }).end("no"),
  );
  server.listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const client = new McpClient({ url: `http://127.0.0.1:${server.address().port}/mcp` });
    await assert.rejects(
      () => client.listTools(),
      (e) => e instanceof McpError && e.code === 401,
    );
    // The failed handshake left no half-session behind: the next call tries again.
    await assert.rejects(
      () => client.listTools(),
      (e) => e instanceof McpError,
    );
  } finally {
    server.close();
  }
});
