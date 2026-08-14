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

test("POST /mcp tools/list returns all 16 tools", async () => {
  const { sessionId } = await initialize();
  const { message } = await mcpPost(sessionId, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
  const names = message.result.tools.map((t: { name: string }) => t.name);
  assert.equal(names.length, 16);
  assert.ok(names.includes("add_memories"));
  assert.ok(names.includes("batch_add_memories"));
  assert.ok(names.includes("get_memories"));
  assert.ok(names.includes("export_memories"));
  assert.ok(names.includes("import_memories"));
  assert.ok(names.includes("review_stale"));
  assert.ok(names.includes("health_check"));
});

test("POST /mcp requires a bearer token when API_TOKEN is set", async () => {
  setConfig("API_TOKEN", "sekrit-token-123456");
  try {
    const noAuth = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: ACCEPT },
      body: INIT,
    });
    assert.equal(noAuth.status, 401);
    const badAuth = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: ACCEPT, Authorization: "Bearer wrong-token-123456" },
      body: INIT,
    });
    assert.equal(badAuth.status, 401);
    const ok = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: ACCEPT, Authorization: "Bearer sekrit-token-123456" },
      body: INIT,
    });
    assert.equal(ok.status, 200);
  } finally {
    setConfig("API_TOKEN", "");
  }
});

test("POST /mcp rejects oversized request bodies with 413", async () => {
  const huge = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { data: "x".repeat(6 * 1024 * 1024) } });
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: ACCEPT, "Content-Length": String(huge.length) },
    body: huge,
  });
  assert.equal(res.status, 413);
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
    return new Response(JSON.stringify({ result: { status: "completed", operation_id: 1, points: [] } }), {
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
  assert.equal(parsed.merged, 0);
  assert.equal(parsed.skipped, 0);
  assert.equal(parsed.memories.length, 1);
  assert.equal(parsed.memories[0].text, "remember pnpm");
  assert.equal(parsed.memories[0].action, "inserted");
  assert.ok(parsed.memories[0].id);
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

test("tools/call rejects empty-string project on all project-aware tools", async () => {
  const { sessionId } = await initialize();
  const calls = [
    { name: "add_memories", arguments: { text: "x", project: "" } },
    { name: "search_memory", arguments: { query: "x", project: "" } },
    { name: "list_memories", arguments: { project: "" } },
    { name: "delete_all_memories", arguments: { project: "" } },
    { name: "export_memories", arguments: { project: "" } },
    { name: "review_stale", arguments: { project: "" } },
  ];
  for (let i = 0; i < calls.length; i++) {
    const { message } = await mcpPost(sessionId, JSON.stringify({
      jsonrpc: "2.0",
      id: 30 + i,
      method: "tools/call",
      params: { name: calls[i].name, arguments: calls[i].arguments },
    }));
    assert.equal(message.result.isError, true, `${calls[i].name} should fail`);
    const text = JSON.parse(message.result.content[0].text);
    assert.equal(text.code, "VALIDATION_ERROR", `${calls[i].name} code`);
    assert.match(text.error, /project must be a non-empty string/, `${calls[i].name} message`);
  }
});

test("new tools reject invalid arguments", async () => {
  const { sessionId } = await initialize();
  const calls = [
    { name: "batch_add_memories", arguments: { items: [] } },
    { name: "batch_add_memories", arguments: { items: [{}] } },
    { name: "get_memories", arguments: { ids: [] } },
    { name: "get_memories", arguments: { ids: ["not-a-uuid"] } },
    { name: "get_memory", arguments: { memory_id: "not-a-uuid" } },
    { name: "delete_memories", arguments: { ids: ["not-a-uuid"] } },
    { name: "import_memories", arguments: {} },
    { name: "review_stale", arguments: { days: 0 } },
    { name: "search_memory", arguments: { query: "x", exact: "yes" } },
    { name: "search_memory", arguments: { query: "x", min_score: 1.5 } },
    { name: "search_memory", arguments: { query: "x", min_score: -0.1 } },
    { name: "search_memory", arguments: { query: "x", exact: true, min_score: 0.5 } },
    { name: "batch_add_memories", arguments: { items: [{ text: "" }] } },
    { name: "add_memories", arguments: { text: "x", threshold: 0 } },
    { name: "add_memories", arguments: { text: "x", threshold: 1 } },
    { name: "add_memories", arguments: { text: "x", dedup: "yes" } },
  ];
  for (let i = 0; i < calls.length; i++) {
    const { message } = await mcpPost(sessionId, JSON.stringify({
      jsonrpc: "2.0",
      id: 50 + i,
      method: "tools/call",
      params: { name: calls[i].name, arguments: calls[i].arguments },
    }));
    assert.equal(message.result.isError, true, `${calls[i].name} should fail`);
    const text = JSON.parse(message.result.content[0].text);
    assert.equal(text.code, "VALIDATION_ERROR", `${calls[i].name} code`);
  }
});

test("batch_add_memories processes all items with per-item outcomes", async (t) => {
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
      return new Response(JSON.stringify({ choices: [{ message: { content: '["fact one"]' } }] }), { status: 200 });
    }
    if (u.includes("/embeddings")) {
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: { status: "completed", operation_id: 1, points: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
    });
  });
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 60,
    method: "tools/call",
    params: { name: "batch_add_memories", arguments: { items: [{ text: "one", project: "p1" }, { text: "two", project: "p2" }] } },
  }));
  const text = JSON.parse(message.result.content[0].text);
  assert.equal(text.processed, 2);
  assert.equal(text.items.length, 2);
  assert.equal(text.items[0].index, 0);
  assert.equal(text.items[0].added, 1);
  assert.equal(text.items[1].index, 1);
  assert.equal(text.items[1].added, 1);
  assert.equal(text.items[0].memories[0].action, "inserted");
});

test("export_memories returns an export envelope", async (t) => {
  const { sessionId } = await initialize();
  const originalFetch = globalThis.fetch.bind(globalThis);
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(`http://127.0.0.1:${port}`)) return originalFetch(url, init);
    return new Response(JSON.stringify({ result: { points: [], next_page_offset: null } }), {
      status: 200,
      headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
    });
  });
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 61,
    method: "tools/call",
    params: { name: "export_memories", arguments: {} },
  }));
  const text = JSON.parse(message.result.content[0].text);
  assert.ok(text.exported_at);
  assert.equal(text.count, 0);
  assert.deepEqual(text.memories, []);
});

test("import_memories imports valid export data", async (t) => {
  const { sessionId } = await initialize();
  setConfig("EMBED_MODEL", "text-embedding-3-small");
  setConfig("EMBED_BASE", "http://embed.test:1");
  setConfig("EMBED_KEY", "k");
  const originalFetch = globalThis.fetch.bind(globalThis);
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(`http://127.0.0.1:${port}`)) return originalFetch(url, init);
    if (u.includes("/embeddings")) {
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: { status: "completed", operation_id: 1, points: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
    });
  });
  const data = JSON.stringify({ memories: [{ id: "keep-me", text: "hello", project: "p", importance: 0.5 }] });
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 62,
    method: "tools/call",
    params: { name: "import_memories", arguments: { data } },
  }));
  const text = JSON.parse(message.result.content[0].text);
  assert.equal(text.imported, 1);
  assert.deepEqual(text.failed, []);
});

test("review_stale returns a report without touching data", async (t) => {
  const { sessionId } = await initialize();
  const originalFetch = globalThis.fetch.bind(globalThis);
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(`http://127.0.0.1:${port}`)) return originalFetch(url, init);
    return new Response(JSON.stringify({ result: { points: [], next_page_offset: null } }), {
      status: 200,
      headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
    });
  });
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 63,
    method: "tools/call",
    params: { name: "review_stale", arguments: { days: 3 } },
  }));
  const text = JSON.parse(message.result.content[0].text);
  assert.equal(text.report_only, true);
  assert.equal(text.checked, 0);
  assert.equal(text.buckets.expired.count, 0);
});

test("review_stale reports exact counts even when the memories list is capped by limit", async (t) => {
  const { sessionId } = await initialize();
  const originalFetch = globalThis.fetch.bind(globalThis);
  const past = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const page = (n: number) => Array.from({ length: n }, (_, i) => ({
    id: `id-${i}`,
    payload: { text: `expired fact ${i}`, expires_at: past, created_at: past },
  }));
  let scrollCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(`http://127.0.0.1:${port}`)) return originalFetch(url, init);
    if (u.includes("/points/scroll")) {
      scrollCalls++;
      if (scrollCalls === 1) {
        return new Response(JSON.stringify({ result: { points: page(50), next_page_offset: "page2" } }), {
          status: 200,
          headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
        });
      }
      return new Response(JSON.stringify({ result: { points: page(10), next_page_offset: null } }), {
        status: 200,
        headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
      });
    }
    return new Response(JSON.stringify({ result: {} }), { status: 200, headers: { "Content-Type": "application/json", "server-version": "1.18.0" } });
  });
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 64,
    method: "tools/call",
    params: { name: "review_stale", arguments: { limit: 10 } },
  }));
  const text = JSON.parse(message.result.content[0].text);
  assert.equal(text.checked, 60);
  assert.equal(text.buckets.expired.count, 60);
  assert.equal(text.buckets.expired.memories.length, 10);
});

test("list_memories requests newest-first ordering by created_at", async (t) => {
  const { sessionId } = await initialize();
  const originalFetch = globalThis.fetch.bind(globalThis);
  let scrollBody: any = null;
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(`http://127.0.0.1:${port}`)) return originalFetch(url, init);
    if (u.includes("/points/scroll")) {
      scrollBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(JSON.stringify({ result: { points: [], next_page_offset: null } }), {
        status: 200,
        headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
      });
    }
    return new Response(JSON.stringify({ result: {} }), { status: 200, headers: { "Content-Type": "application/json", "server-version": "1.18.0" } });
  });
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 65,
    method: "tools/call",
    params: { name: "list_memories", arguments: { limit: 5 } },
  }));
  assert.ok(scrollBody, "scroll request body captured");
  assert.deepEqual(scrollBody.order_by, { key: "created_at", direction: "desc" });
  const text = JSON.parse(message.result.content[0].text);
  assert.deepEqual(text.memories, []);
});

test("update_config masks secret values in the response", async () => {
  const { sessionId } = await initialize();
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 31,
    method: "tools/call",
    params: { name: "update_config", arguments: { key: "LLM_KEY", value: "sk-secret-value-1234" } },
  }));
  const text = JSON.parse(message.result.content[0].text);
  assert.equal(text.updated, "LLM_KEY");
  assert.equal(text.value, "sk-s****1234");
});

test("update_config masks API_TOKEN in the response", async () => {
  const { sessionId } = await initialize();
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 32,
    method: "tools/call",
    params: { name: "update_config", arguments: { key: "API_TOKEN", value: "sekrit-token-123456" } },
  }));
  try {
    const text = JSON.parse(message.result.content[0].text);
    assert.equal(text.updated, "API_TOKEN");
    assert.equal(text.value, "sekr****3456");
  } finally {
    setConfig("API_TOKEN", "");
  }
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

test("idle sessions are pruned after the idle timeout", async () => {
  const tiny = createHttpServer(() => createMcpServer("test"), { sessionIdleMs: 50 });
  await new Promise<void>((resolve) => tiny.httpServer.listen(0, "127.0.0.1", resolve));
  const tinyPort = (tiny.httpServer.address() as AddressInfo).port;
  const tinyBase = `http://127.0.0.1:${tinyPort}`;
  try {
    const initRes = await fetch(`${tinyBase}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: ACCEPT },
      body: INIT,
    });
    assert.equal(initRes.status, 200);
    const sessionId = initRes.headers.get("mcp-session-id");
    assert.ok(sessionId);
    await initRes.text();
    await new Promise((r) => setTimeout(r, 1500));
    const after = await fetch(`${tinyBase}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: ACCEPT, "mcp-session-id": sessionId! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
    });
    assert.equal(after.status, 404);
  } finally {
    await tiny.close();
  }
});
