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
  "EMBED_BASE_URL", "EMBED_KEY", "EMBED_API_KEY", "MEMORYHUB_SESSION_IDLE_MS",
];

for (const k of ENV_KEYS) delete process.env[k];
process.env.MEMORYHUB_DIR = mkdtempSync(join(tmpdir(), "memoryhub-test-"));
process.env.MEMORYHUB_RETRY_DELAY_MS = "1";

const { createMcpServer } = await import("../src/mcp.js");
const { createHttpServer } = await import("../src/http.js");
const { setConfig, getConfig } = await import("../src/config.js");

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
  const saved = { QDRANT_URL: getConfig("QDRANT_URL"), EMBED_MODEL: getConfig("EMBED_MODEL"), EMBED_BASE: getConfig("EMBED_BASE"), EMBED_KEY: getConfig("EMBED_KEY"), LLM_MODEL: getConfig("LLM_MODEL"), LLM_BASE: getConfig("LLM_BASE"), LLM_KEY: getConfig("LLM_KEY") };
  setConfig("QDRANT_URL", "http://qdrant.test:6333");
  setConfig("EMBED_MODEL", "text-embedding-3-small");
  setConfig("EMBED_BASE", "http://embed.test:1");
  setConfig("EMBED_KEY", "k");
  setConfig("LLM_MODEL", "gpt-4o-mini");
  setConfig("LLM_BASE", "http://llm.test:1");
  setConfig("LLM_KEY", "k");
  try {
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
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v) setConfig(k, v); }
  }
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
    { name: "get_memories", arguments: { ids: [""] } },
    { name: "get_memory", arguments: { memory_id: "" } },
    { name: "delete_memories", arguments: { ids: [""] } },
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
  const saved = { QDRANT_URL: getConfig("QDRANT_URL"), EMBED_MODEL: getConfig("EMBED_MODEL"), EMBED_BASE: getConfig("EMBED_BASE"), EMBED_KEY: getConfig("EMBED_KEY"), LLM_MODEL: getConfig("LLM_MODEL"), LLM_BASE: getConfig("LLM_BASE"), LLM_KEY: getConfig("LLM_KEY") };
  setConfig("QDRANT_URL", "http://qdrant.test:6333");
  setConfig("EMBED_MODEL", "text-embedding-3-small");
  setConfig("EMBED_BASE", "http://embed.test:1");
  setConfig("EMBED_KEY", "k");
  setConfig("LLM_MODEL", "gpt-4o-mini");
  setConfig("LLM_BASE", "http://llm.test:1");
  setConfig("LLM_KEY", "k");
  try {
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
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v) setConfig(k, v); }
  }
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

test("import_memories normalizes legacy string ids to deterministic UUIDs", async (t) => {
  const { sessionId } = await initialize();
  setConfig("EMBED_MODEL", "text-embedding-3-small");
  setConfig("EMBED_BASE", "http://embed.test:1");
  setConfig("EMBED_KEY", "k");
  const originalFetch = globalThis.fetch.bind(globalThis);
  const storedIds: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(`http://127.0.0.1:${port}`)) return originalFetch(url, init);
    if (u.includes("/embeddings")) {
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });
    }
    if (u.includes("/points")) {
      const body = JSON.parse(String(init?.body));
      if (Array.isArray(body?.points)) storedIds.push(...body.points.map((p: { id: unknown }) => p.id));
    }
    return new Response(JSON.stringify({ result: { status: "completed", operation_id: 1, points: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
    });
  });
  const data = JSON.stringify({
    memories: [{ id: "legacy-1", text: "a", project: "p" }, { id: "legacy-1", text: "b", project: "p" }],
  });
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 62,
    method: "tools/call",
    params: { name: "import_memories", arguments: { data } },
  }));
  const text = JSON.parse(message.result.content[0].text);
  assert.equal(text.imported, 2);
  assert.equal(storedIds.length, 2);
  const uuidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  assert.match(String(storedIds[0]), uuidRe);
  assert.notEqual(String(storedIds[0]), "legacy-1");
  assert.equal(String(storedIds[0]), String(storedIds[1]), "same legacy id maps to the same UUID");
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

test("list_memories returns results from Qdrant", async (t) => {
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
  assert.equal(scrollBody.order_by, undefined, "order_by is not used (Qdrant scroll order_by returns empty results)");
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

test("update_config reports empty string for cleared secret, not a mask", async () => {
  const { sessionId } = await initialize();
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 33,
    method: "tools/call",
    params: { name: "update_config", arguments: { key: "API_TOKEN", value: "" } },
  }));
  try {
    const text = JSON.parse(message.result.content[0].text);
    assert.equal(text.updated, "API_TOKEN");
    assert.equal(text.value, "");
    assert.equal(text.persisted, false);
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
    await new Promise((r) => setTimeout(r, 600));
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

test("idle session is evicted lazily at request time, before the sweep", async () => {
  const lazy = createHttpServer(() => createMcpServer("test"), { sessionIdleMs: 50 });
  await new Promise<void>((resolve) => lazy.httpServer.listen(0, "127.0.0.1", resolve));
  const p = (lazy.httpServer.address() as AddressInfo).port;
  const b = `http://127.0.0.1:${p}`;
  try {
    const initRes = await fetch(`${b}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: ACCEPT },
      body: INIT,
    });
    assert.equal(initRes.status, 200);
    const sessionId = initRes.headers.get("mcp-session-id");
    assert.ok(sessionId);
    await initRes.text();
    await new Promise((r) => setTimeout(r, 60));
    const after = await fetch(`${b}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: ACCEPT, "mcp-session-id": sessionId! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 103, method: "tools/list", params: {} }),
    });
    assert.equal(after.status, 404, "request-time expiry returns 404 even before the sweep runs");
  } finally {
    await lazy.close();
  }
});

test("sessions are not pruned when idle expiry is disabled", async () => {
  const noExpire = createHttpServer(() => createMcpServer("test"), { sessionIdleMs: 0 });
  await new Promise<void>((resolve) => noExpire.httpServer.listen(0, "127.0.0.1", resolve));
  const p = (noExpire.httpServer.address() as AddressInfo).port;
  const b = `http://127.0.0.1:${p}`;
  try {
    const initRes = await fetch(`${b}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: ACCEPT },
      body: INIT,
    });
    assert.equal(initRes.status, 200);
    const sessionId = initRes.headers.get("mcp-session-id");
    assert.ok(sessionId);
    await initRes.text();
    await new Promise((r) => setTimeout(r, 600));
    const after = await fetch(`${b}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: ACCEPT, "mcp-session-id": sessionId! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 100, method: "tools/list", params: {} }),
    });
    assert.equal(after.status, 200);
    await after.text();
  } finally {
    await noExpire.close();
  }
});

test("SESSION_IDLE_MS config enables idle pruning", async () => {
  setConfig("SESSION_IDLE_MS", "50");
  try {
    const cfg = createHttpServer(() => createMcpServer("test"));
    await new Promise<void>((resolve) => cfg.httpServer.listen(0, "127.0.0.1", resolve));
    const p = (cfg.httpServer.address() as AddressInfo).port;
    const b = `http://127.0.0.1:${p}`;
    try {
      const initRes = await fetch(`${b}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: ACCEPT },
        body: INIT,
      });
      assert.equal(initRes.status, 200);
      const sessionId = initRes.headers.get("mcp-session-id");
      assert.ok(sessionId);
      await initRes.text();
      await new Promise((r) => setTimeout(r, 600));
      const after = await fetch(`${b}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: ACCEPT, "mcp-session-id": sessionId! },
        body: JSON.stringify({ jsonrpc: "2.0", id: 101, method: "tools/list", params: {} }),
      });
      assert.equal(after.status, 404);
    } finally {
      await cfg.close();
    }
  } finally {
    setConfig("SESSION_IDLE_MS", "0");
  }
});

test("LRU eviction frees capacity at MAX_SESSIONS", async () => {
  const lru = createHttpServer(() => createMcpServer("test"));
  await new Promise<void>((resolve) => lru.httpServer.listen(0, "127.0.0.1", resolve));
  const p = (lru.httpServer.address() as AddressInfo).port;
  const b = `http://127.0.0.1:${p}`;
  try {
    const ids: string[] = [];
    for (let i = 0; i < 101; i++) {
      const res = await fetch(`${b}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: ACCEPT },
        body: INIT,
      });
      assert.equal(res.status, 200);
      const sid = res.headers.get("mcp-session-id");
      assert.ok(sid, `session ${i} has an id`);
      await res.text();
      ids.push(sid!);
    }
    const list = (sid: string) => fetch(`${b}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: ACCEPT, "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", id: 102, method: "tools/list", params: {} }),
    });
    const first = await list(ids[0]);
    assert.equal(first.status, 404, "oldest session evicted");
    const second = await list(ids[1]);
    assert.equal(second.status, 200, "second-oldest session survives");
    await second.text();
    const newest = await list(ids[100]);
    assert.equal(newest.status, 200, "newest session works");
    await newest.text();
  } finally {
    await lru.close();
  }
});

// --- Auth edge cases ---

test("POST /mcp rejects Basic auth scheme", async () => {
  setConfig("API_TOKEN", "test-token-abc123");
  try {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: ACCEPT, Authorization: "Basic dGVzdC10b2tlbi1hYmMxMjM=" },
      body: INIT,
    });
    assert.equal(res.status, 401);
  } finally {
    setConfig("API_TOKEN", "");
  }
});

test("GET /mcp without auth returns 401 when API_TOKEN is set", async () => {
  setConfig("API_TOKEN", "test-token-abc123");
  try {
    const res = await fetch(`${base}/mcp`, { method: "GET" });
    assert.equal(res.status, 401);
  } finally {
    setConfig("API_TOKEN", "");
  }
});

test("DELETE /mcp without auth returns 401 when API_TOKEN is set", async () => {
  setConfig("API_TOKEN", "test-token-abc123");
  try {
    const res = await fetch(`${base}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": "fake" },
    });
    assert.equal(res.status, 401);
  } finally {
    setConfig("API_TOKEN", "");
  }
});

// --- MCP error-code classification ---

test("unknown tool returns INTERNAL_ERROR", async () => {
  const { sessionId } = await initialize();
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 200,
    method: "tools/call",
    params: { name: "nonexistent_tool", arguments: {} },
  }));
  assert.equal(message.result.isError, true);
  const text = JSON.parse(message.result.content[0].text);
  assert.equal(text.code, "INTERNAL_ERROR");
});

test("error with 'config' in message returns CONFIG_ERROR", async (t) => {
  const { sessionId } = await initialize();
  const originalFetch = globalThis.fetch.bind(globalThis);
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(`http://127.0.0.1:${port}`)) return originalFetch(url, init);
    throw new Error("Qdrant config is missing");
  });
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 201,
    method: "tools/call",
    params: { name: "memory_stats", arguments: {} },
  }));
  assert.equal(message.result.isError, true);
  const text = JSON.parse(message.result.content[0].text);
  assert.equal(text.code, "CONFIG_ERROR");
});

test("error with 'not found' returns NOT_FOUND", async (t) => {
  const { sessionId } = await initialize();
  const originalFetch = globalThis.fetch.bind(globalThis);
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(`http://127.0.0.1:${port}`)) return originalFetch(url, init);
    if (u.includes("/points/")) {
      return new Response(JSON.stringify({ result: { points: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
      });
    }
    throw new Error("point not found");
  });
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 202,
    method: "tools/call",
    params: { name: "get_memory", arguments: { memory_id: "does-not-exist" } },
  }));
  assert.equal(message.result.isError, true);
  const text = JSON.parse(message.result.content[0].text);
  assert.equal(text.code, "NOT_FOUND");
});

// --- get_config / update_config persist:true ---

test("get_config returns current effective values", async () => {
  const { sessionId } = await initialize();
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 210,
    method: "tools/call",
    params: { name: "get_config", arguments: {} },
  }));
  const text = JSON.parse(message.result.content[0].text);
  assert.ok(typeof text === "object");
  assert.ok("COLLECTION" in text);
});

test("update_config persist:true returns persisted flag", async () => {
  const { sessionId } = await initialize();
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 211,
    method: "tools/call",
    params: { name: "update_config", arguments: { key: "EMBED_MODEL", value: "test-persist-model", persist: true } },
  }));
  const text = JSON.parse(message.result.content[0].text);
  assert.equal(text.updated, "EMBED_MODEL");
  assert.equal(text.persisted, true);
  assert.ok(typeof text.path === "string");
});

// --- Happy-path tests ---

function mockQdrant(t: any, opts: { search?: any[]; scroll?: any[]; points?: any[]; upsert?: boolean }) {
  const originalFetch = globalThis.fetch.bind(globalThis);
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(`http://127.0.0.1:${port}`)) return originalFetch(url, init);
    if (u.includes("/embeddings")) {
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if ((u.includes("/collections") || new URL(u).pathname === "/") && !u.includes("/points")) {
      if (new URL(u).pathname === "/") {
        return new Response(JSON.stringify({ title: "qdrant - vector engine", version: "1.18.0" }), {
          status: 200,
          headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
        });
      }
      return new Response(JSON.stringify({ result: { status: "green", optimizer_status: "ok", points_count: 5, config: { params: { vectors: { size: 2, distance: "Cosine" } } } } }), {
        status: 200,
        headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
      });
    }
    if (u.includes("/points/search") || u.includes("/points/query")) {
      return new Response(JSON.stringify({ result: { points: opts.search ?? [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
      });
    }
    if (u.includes("/points/scroll")) {
      return new Response(JSON.stringify({ result: { points: opts.scroll ?? [], next_page_offset: null } }), {
        status: 200,
        headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
      });
    }
    if (u.includes("/points/delete")) {
      return new Response(JSON.stringify({ result: { status: "completed", operation_id: 1 } }), {
        status: 200,
        headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
      });
    }
    if (u.includes("/points")) {
      let body: any = {};
      try {
        if (typeof init?.body === "string") body = JSON.parse(init.body);
        else if (init?.body instanceof Uint8Array) body = JSON.parse(new TextDecoder().decode(init.body));
      } catch {}
      if (body.ids) {
        return new Response(JSON.stringify({ result: opts.points ?? body.ids.map((id: string) => ({ id, payload: {}, vector: [] })) }), {
          status: 200,
          headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
        });
      }
      return new Response(JSON.stringify({ result: { status: "completed", operation_id: 1, points: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
      });
    }
    return new Response(JSON.stringify({ result: {} }), { status: 200, headers: { "Content-Type": "application/json", "server-version": "1.18.0" } });
  });
}

test("search_memory returns results from Qdrant", async (t) => {
  const { sessionId } = await initialize();
  setConfig("QDRANT_URL", "http://qdrant.test:6333");
  setConfig("EMBED_MODEL", "text-embedding-3-small");
  setConfig("EMBED_BASE", "http://embed.test:1");
  setConfig("EMBED_KEY", "k");
  mockQdrant(t, {
    search: [{ id: "abc-123", payload: { text: "remember pnpm", project: "default" }, score: 0.95 }],
  });
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 300,
    method: "tools/call",
    params: { name: "search_memory", arguments: { query: "pnpm" } },
  }));
  const raw = message.result.content[0].text;
  const text = JSON.parse(raw);
  assert.ok(Array.isArray(text));
  assert.equal(text.length, 1);
  assert.equal(text[0].text, "remember pnpm");
  assert.equal(text[0].score, 0.95);
});

test("search_memory exact mode skips embedding", async (t) => {
  const { sessionId } = await initialize();
  setConfig("QDRANT_URL", "http://qdrant.test:6333");
  let embedCalled = false;
  const originalFetch = globalThis.fetch.bind(globalThis);
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(`http://127.0.0.1:${port}`)) return originalFetch(url, init);
    if (u.includes("/embeddings")) { embedCalled = true; throw new Error("should not embed"); }
    if (u.includes("/points/scroll")) {
      return new Response(JSON.stringify({ result: { points: [{ id: "x", payload: { text: "hello world" } }], next_page_offset: null } }), {
        status: 200, headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
      });
    }
    return new Response(JSON.stringify({ result: {} }), { status: 200, headers: { "Content-Type": "application/json", "server-version": "1.18.0" } });
  });
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 301,
    method: "tools/call",
    params: { name: "search_memory", arguments: { query: "hello", exact: true } },
  }));
  assert.equal(embedCalled, false);
  const text = JSON.parse(message.result.content[0].text);
  assert.ok(Array.isArray(text));
  assert.ok(text.length >= 1);
});

test("get_memory returns a single memory", async (t) => {
  const { sessionId } = await initialize();
  setConfig("QDRANT_URL", "http://qdrant.test:6333");
  mockQdrant(t, {
    points: [{ id: "abc-123", payload: { text: "fact one", project: "p", created_at: "2026-01-01T00:00:00.000Z" } }],
  });
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 302,
    method: "tools/call",
    params: { name: "get_memory", arguments: { memory_id: "abc-123" } },
  }));
  const text = JSON.parse(message.result.content[0].text);
  assert.equal(text.id, "abc-123");
  assert.equal(text.text, "fact one");
  assert.equal(text.project, "p");
});

test("get_memories returns multiple memories", async (t) => {
  const { sessionId } = await initialize();
  setConfig("QDRANT_URL", "http://qdrant.test:6333");
  mockQdrant(t, {
    points: [
      { id: "a", payload: { text: "one" } },
      { id: "b", payload: { text: "two" } },
    ],
  });
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 303,
    method: "tools/call",
    params: { name: "get_memories", arguments: { ids: ["a", "b"] } },
  }));
  const text = JSON.parse(message.result.content[0].text);
  assert.ok(Array.isArray(text.memories));
  assert.equal(text.memories.length, 2);
  assert.equal(text.memories[0].text, "one");
  assert.equal(text.memories[1].text, "two");
});

test("delete_memories removes points by ID", async (t) => {
  const { sessionId } = await initialize();
  setConfig("QDRANT_URL", "http://qdrant.test:6333");
  const deletedIds: unknown[] = [];
  const originalFetch = globalThis.fetch.bind(globalThis);
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(`http://127.0.0.1:${port}`)) return originalFetch(url, init);
    if (u.includes("/embeddings")) {
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });
    }
    if (u.includes("/points/delete")) {
      let rawBody = "";
      if (typeof init?.body === "string") rawBody = init.body;
      else if (init?.body instanceof Uint8Array) rawBody = new TextDecoder().decode(init.body);
      const body = JSON.parse(rawBody || "{}");
      deletedIds.push(...(body?.points ?? body?.filter?.must?.[0]?.has_id ?? []));
      return new Response(JSON.stringify({ result: { status: "completed", operation_id: 1 } }), {
        status: 200,
        headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
      });
    }
    if ((u.includes("/collections") || new URL(u).pathname === "/") && !u.includes("/points")) {
      if (new URL(u).pathname === "/") {
        return new Response(JSON.stringify({ title: "qdrant - vector engine", version: "1.18.0" }), {
          status: 200, headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
        });
      }
      return new Response(JSON.stringify({ result: { status: "green", points_count: 2 } }), {
        status: 200,
        headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
      });
    }
    if (u.includes("/points")) {
      let body: any = {};
      try {
        if (typeof init?.body === "string") body = JSON.parse(init.body);
        else if (init?.body instanceof Uint8Array) body = JSON.parse(new TextDecoder().decode(init.body));
      } catch {}
      if (body.ids) {
        return new Response(JSON.stringify({ result: body.ids.map((id: string) => ({ id, payload: {}, vector: [] })) }), {
          status: 200,
          headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
        });
      }
      return new Response(JSON.stringify({ result: { status: "completed", operation_id: 1, points: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
      });
    }
    return new Response(JSON.stringify({ result: {} }), { status: 200, headers: { "Content-Type": "application/json", "server-version": "1.18.0" } });
  });
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 304,
    method: "tools/call",
    params: { name: "delete_memories", arguments: { ids: ["id-1", "id-2"] } },
  }));
  const text = JSON.parse(message.result.content[0].text);
  assert.equal(text.deleted, 2);
  assert.equal(deletedIds.length, 2);
});

test("delete_all_memories deletes with filter", async (t) => {
  const { sessionId } = await initialize();
  setConfig("QDRANT_URL", "http://qdrant.test:6333");
  let deleteBody: any = null;
  const originalFetch = globalThis.fetch.bind(globalThis);
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(`http://127.0.0.1:${port}`)) return originalFetch(url, init);
    if (u.includes("/points/delete")) {
      let rawBody = "";
      if (typeof init?.body === "string") rawBody = init.body;
      else if (init?.body instanceof Uint8Array) rawBody = new TextDecoder().decode(init.body);
      deleteBody = rawBody ? JSON.parse(rawBody) : null;
    }
    return new Response(JSON.stringify({ result: { status: "completed", operation_id: 1 } }), {
      status: 200,
      headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
    });
  });
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 305,
    method: "tools/call",
    params: { name: "delete_all_memories", arguments: {} },
  }));
  const text = JSON.parse(message.result.content[0].text);
  assert.equal(typeof text.deleted, "number");
  assert.ok(deleteBody, "delete request was made");
});

test("memory_stats returns collection info", async (t) => {
  const { sessionId } = await initialize();
  setConfig("QDRANT_URL", "http://qdrant.test:6333");
  const past = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const page = Array.from({ length: 3 }, (_, i) => ({
    id: `s-${i}`,
    payload: { text: `stat fact ${i}`, created_at: past, project: "proj", source: "chat" },
  }));
  mockQdrant(t, { scroll: page });
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 306,
    method: "tools/call",
    params: { name: "memory_stats", arguments: {} },
  }));
  const text = JSON.parse(message.result.content[0].text);
  assert.equal(typeof text.vectors_count, "number");
  assert.ok(text.by_project);
  assert.ok(text.by_source);
});

test("health_check returns ok when Qdrant is reachable", async (t) => {
  const { sessionId } = await initialize();
  const originalFetch = globalThis.fetch.bind(globalThis);
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(`http://127.0.0.1:${port}`)) return originalFetch(url, init);
    return new Response(JSON.stringify({ result: { collections: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
    });
  });
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 307,
    method: "tools/call",
    params: { name: "health_check", arguments: {} },
  }));
  const text = JSON.parse(message.result.content[0].text);
  assert.equal(text.status, "ok");
  assert.equal(text.qdrant, "connected");
});

test("health_check returns degraded when Qdrant is unreachable", async (t) => {
  const { sessionId } = await initialize();
  const originalFetch = globalThis.fetch.bind(globalThis);
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(`http://127.0.0.1:${port}`)) return originalFetch(url, init);
    throw new Error("ECONNREFUSED");
  });
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 308,
    method: "tools/call",
    params: { name: "health_check", arguments: {} },
  }));
  const text = JSON.parse(message.result.content[0].text);
  assert.equal(text.status, "degraded");
  assert.equal(text.qdrant, "unreachable");
});

// --- Import/export edge cases ---

test("import_memories reports per-item failures", async (t) => {
  const { sessionId } = await initialize();
  setConfig("QDRANT_URL", "http://qdrant.test:6333");
  setConfig("EMBED_MODEL", "text-embedding-3-small");
  setConfig("EMBED_BASE", "http://embed.test:1");
  setConfig("EMBED_KEY", "k");
  const originalFetch = globalThis.fetch.bind(globalThis);
  let upsertBodies: any[] = [];
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(`http://127.0.0.1:${port}`)) return originalFetch(url, init);
    if (u.includes("/embeddings")) {
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });
    }
    if (u.includes("/points")) {
      const body = JSON.parse(String(init?.body));
      upsertBodies.push(body);
      if (upsertBodies.length === 1) {
        return new Response(JSON.stringify({ status: "error", operation_id: 1, status_detail: "fail" }), { status: 500, headers: { "Content-Type": "application/json", "server-version": "1.18.0" } });
      }
    }
    return new Response(JSON.stringify({ result: { status: "completed", operation_id: 1, points: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
    });
  });
  const data = JSON.stringify({ memories: [{ text: "will fail on upsert" }, { text: "will succeed" }] });
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 310,
    method: "tools/call",
    params: { name: "import_memories", arguments: { data } },
  }));
  const text = JSON.parse(message.result.content[0].text);
  assert.ok(text.imported <= 2);
  assert.ok(typeof text.failed === "object");
});

test("export_memories truncates at cap", async (t) => {
  const { sessionId } = await initialize();
  setConfig("QDRANT_URL", "http://qdrant.test:6333");
  const originalFetch = globalThis.fetch.bind(globalThis);
  let scrollCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith(`http://127.0.0.1:${port}`)) return originalFetch(url, init);
    if ((u.includes("/collections") || new URL(u).pathname === "/") && !u.includes("/points")) {
      if (new URL(u).pathname === "/") {
        return new Response(JSON.stringify({ title: "qdrant - vector engine", version: "1.18.0" }), {
          status: 200, headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
        });
      }
      return new Response(JSON.stringify({ result: { status: "green", points_count: 100000 } }), {
        status: 200, headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
      });
    }
    if (u.includes("/points/scroll")) {
      scrollCalls++;
      if (scrollCalls === 1) {
        const points = Array.from({ length: 60000 }, (_, i) => ({ id: `p-${i}`, payload: { text: `f${i}` } }));
        return new Response(JSON.stringify({ result: { points, next_page_offset: "page2" } }), {
          status: 200, headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
        });
      }
      return new Response(JSON.stringify({ result: { points: [], next_page_offset: null } }), {
        status: 200, headers: { "Content-Type": "application/json", "server-version": "1.18.0" },
      });
    }
    return new Response(JSON.stringify({ result: {} }), { status: 200, headers: { "Content-Type": "application/json", "server-version": "1.18.0" } });
  });
  const { message } = await mcpPost(sessionId, JSON.stringify({
    jsonrpc: "2.0",
    id: 311,
    method: "tools/call",
    params: { name: "export_memories", arguments: {} },
  }));
  const text = JSON.parse(message.result.content[0].text);
  assert.ok(text.memories.length <= 50000);
  assert.equal(text.truncated, true);
});

// --- Strengthen tools/list assertion ---

test("tools/list returns all 16 tools with correct names", async () => {
  const { sessionId } = await initialize();
  const { message } = await mcpPost(sessionId, JSON.stringify({ jsonrpc: "2.0", id: 320, method: "tools/list", params: {} }));
  const names = message.result.tools.map((t: { name: string }) => t.name).sort();
  const expected = [
    "add_memories", "batch_add_memories", "delete_all_memories",
    "delete_memories", "export_memories", "get_config", "get_memory",
    "get_memories", "health_check", "import_memories", "list_memories",
    "memory_stats", "review_stale", "search_memory", "update_config",
    "update_memory",
  ].sort();
  assert.equal(names.length, 16);
  assert.deepEqual(names, expected);
});
