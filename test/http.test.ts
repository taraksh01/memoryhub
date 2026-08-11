import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const ENV_KEYS = [
  "MEMORYHUB_DIR", "MEMORYHUB_CONFIG", "QDRANT_URL", "MEMORYHUB_COLLECTION",
  "MEMORYHUB_VECTOR_SIZE", "MEMORYHUB_RETRY_DELAY_MS", "LLM_MODEL", "LLM_BASE",
  "LLM_BASE_URL", "LLM_KEY", "LLM_API_KEY", "EMBED_MODEL", "EMBED_BASE",
  "EMBED_BASE_URL", "EMBED_KEY", "EMBED_API_KEY",
];

for (const k of ENV_KEYS) delete process.env[k];
process.env.MEMORYHUB_DIR = mkdtempSync(join(tmpdir(), "memoryhub-test-"));
process.env.MEMORYHUB_RETRY_DELAY_MS = "1";

const { createMcpServer } = await import("../src/mcp.js");
const { createHttpServer } = await import("../src/http.js");
const { setConfig } = await import("../src/config.js");

const { httpServer, close } = createHttpServer(() => createMcpServer("test"));
await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
const port = (httpServer.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

const ACCEPT = "application/json, text/event-stream";
const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  },
});

function sseEvents(body: string): Record<string, string>[] {
  return body
    .split("\n\n")
    .filter((block) => block.trim())
    .map((block) => {
      const event: Record<string, string> = {};
      for (const line of block.split("\n")) {
        const idx = line.indexOf(":");
        if (idx > 0) event[line.slice(0, idx)] = line.slice(idx + 1).trim();
      }
      return event;
    });
}

async function mcpPost(sessionId: string | undefined, body: string): Promise<{ message: Record<string, any> | undefined; status: number }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: ACCEPT };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(`${base}/mcp`, { method: "POST", headers, body });
  const text = await res.text();
  let message: Record<string, any> | undefined;
  try {
    if (res.headers.get("content-type")?.includes("text/event-stream")) {
      const events = sseEvents(text);
      const msg = events.find((e) => e.event === "message");
      if (msg) message = JSON.parse(msg.data);
    } else {
      message = JSON.parse(text);
    }
  } catch {
    message = undefined;
  }
  return { message, status: res.status };
}

async function initialize(): Promise<{ sessionId: string; result: Record<string, any> }> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: ACCEPT },
    body: INIT,
  });
  assert.equal(res.status, 200);
  const sessionId = res.headers.get("mcp-session-id");
  assert.ok(sessionId, "mcp-session-id header present");
  const events = sseEvents(await res.text());
  const msg = events.find((e) => e.event === "message");
  assert.ok(msg, "SSE message event present");
  const message = JSON.parse(msg.data);
  assert.equal(message.result.serverInfo.name, "memoryhub");
  assert.ok(message.result.capabilities.tools);
  return { sessionId: sessionId!, result: message.result };
}

test.after(async () => {
  await close();
});

test("POST /mcp initializes a session over SSE", async () => {
  const { sessionId, result } = await initialize();
  assert.ok(sessionId.length > 0);
  assert.equal(result.protocolVersion, "2025-06-18");
});

test("POST /mcp tools/list returns all 11 tools", async () => {
  const { sessionId } = await initialize();
  const { message } = await mcpPost(sessionId, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
  const names = message.result.tools.map((t: { name: string }) => t.name);
  assert.equal(names.length, 11);
  assert.ok(names.includes("add_memories"));
  assert.ok(names.includes("health_check"));
});

test("POST /mcp tools/call add_memories stores a memory", async (t) => {
  const { sessionId } = await initialize();
  setConfig("QDRANT_URL", "http://qdrant.test:6333");
  setConfig("EMBED_MODEL", "text-embedding-3-small");
  setConfig("EMBED_BASE", "http://embed.test:1");
  setConfig("EMBED_KEY", "k");
  setConfig("LLM_MODEL", "gpt-4o-mini");
  setConfig("LLM_BASE", "http://llm.test:1");
  setConfig("LLM_KEY", "k");
  const originalFetch = globalThis.fetch.bind(globalThis);
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(`http://127.0.0.1:${port}`)) return originalFetch(url, init);
    if (u.includes("/chat/completions")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: '["remember pnpm"]' } }] }), { status: 200 });
    }
    if (u.includes("/embeddings")) {
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: { status: "completed", operation_id: 1 } }), {
      status: 200,
      headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
    });
  });
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "add_memories", arguments: { text: "Tarak prefers pnpm" } },
  }));
  const text = message.result.content[0].text;
  const parsed = JSON.parse(text);
  assert.equal(parsed.added, 1);
  assert.deepEqual(parsed.memories, ["remember pnpm"]);
});

test("tools/call returns structured error for invalid input", async () => {
  const { sessionId } = await initialize();
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "add_memories", arguments: {} },
  }));
  assert.equal(message.result.isError, true);
  const text = JSON.parse(message.result.content[0].text);
  assert.equal(text.code, "VALIDATION_ERROR");
});

test("DELETE /mcp closes the session", async () => {
  const { sessionId } = await initialize();
  const del = await fetch(`${base}/mcp`, {
    method: "DELETE",
    headers: { "mcp-session-id": sessionId },
  });
  assert.equal(del.status, 200);
  const { status } = await mcpPost(sessionId, JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} }));
  assert.equal(status, 404);
});

test("GET /mcp without a session ID is rejected", async () => {
  const res = await fetch(`${base}/mcp`);
  assert.equal(res.status, 400);
});

test("POST /mcp with an unknown session ID is rejected", async () => {
  const { status } = await mcpPost("does-not-exist", JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/list", params: {} }));
  assert.equal(status, 404);
});

test("POST /mcp without both Accept types is rejected", async () => {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: INIT,
  });
  assert.equal(res.status, 406);
});

test("unknown routes return 404", async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
});

test("legacy SSE endpoints are gone", async () => {
  const res = await fetch(`${base}/sse`);
  assert.equal(res.status, 404);
});

test("re-initializing an existing session is rejected", async () => {
  const { sessionId } = await initialize();
  const { status } = await mcpPost(sessionId, INIT);
  assert.equal(status, 400);
  mock.restoreAll();
});
