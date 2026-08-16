import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV_KEYS = [
  "MEMORYHUB_DIR", "MEMORYHUB_CONFIG", "QDRANT_URL", "MEMORYHUB_COLLECTION",
  "MEMORYHUB_VECTOR_SIZE", "MEMORYHUB_RETRY_DELAY_MS", "LLM_MODEL", "LLM_BASE",
  "LLM_BASE_URL", "LLM_KEY", "LLM_API_KEY", "EMBED_MODEL", "EMBED_BASE",
  "EMBED_BASE_URL", "EMBED_KEY", "EMBED_API_KEY",
];

for (const k of ENV_KEYS) delete process.env[k];
process.env.MEMORYHUB_DIR = mkdtempSync(join(tmpdir(), "memoryhub-test-"));
process.env.MEMORYHUB_RETRY_DELAY_MS = "1";

type MemoryModule = typeof import("../src/memory.ts");
const mem = (await import("../src/memory.ts")) as MemoryModule;

function chatCompletion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function httpError(status: number): Response {
  return new Response(`{"error":"boom"}`, { status });
}

function statusError(status: number): Error {
  const e = new Error(`HTTP ${status}`) as Error & { status: number };
  e.status = status;
  return e;
}

test("withRetry resolves on first attempt", async () => {
  let calls = 0;
  const r = await mem.withRetry(async () => { calls++; return "ok"; });
  assert.equal(r, "ok");
  assert.equal(calls, 1);
});

test("withRetry retries on 429 then succeeds", async () => {
  let calls = 0;
  const r = await mem.withRetry(async () => {
    calls++;
    if (calls === 1) throw statusError(429);
    return "ok";
  });
  assert.equal(r, "ok");
  assert.equal(calls, 2);
});

test("withRetry does not retry 4xx errors below 429", async () => {
  let calls = 0;
  await assert.rejects(
    mem.withRetry(async () => { calls++; throw statusError(400); }),
    /HTTP 400/
  );
  assert.equal(calls, 1);
});

test("withRetry gives up after 3 attempts on 500", async () => {
  let calls = 0;
  await assert.rejects(
    mem.withRetry(async () => { calls++; throw statusError(500); }),
    /HTTP 500/
  );
  assert.equal(calls, 3);
});

test("extractMemories parses valid JSON array", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    chatCompletion(JSON.stringify(["remember one", "remember two"]))
  );
  const r = await mem.extractMemories("some text");
  assert.deepEqual(r, ["remember one", "remember two"]);
});

test("extractMemories trims and drops empty facts", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    chatCompletion(JSON.stringify(["  keep me  ", "", "   ", null]))
  );
  const r = await mem.extractMemories("some text");
  assert.deepEqual(r, ["keep me"]);
});

test("extractMemories falls back to raw text when only empty facts are returned", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return chatCompletion(JSON.stringify(["", "  "])); });
  const r = await mem.extractMemories("raw fallback text");
  assert.deepEqual(r, ["raw fallback text"]);
  assert.equal(calls, 2);
});

test("extractMemories strips markdown code fences", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    chatCompletion("```json\n[\"only fact\"]\n```")
  );
  const r = await mem.extractMemories("some text");
  assert.deepEqual(r, ["only fact"]);
});

test("extractMemories retries on LLM error and falls back to raw text", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return httpError(500);
  });
  const r = await mem.extractMemories("raw fallback text");
  assert.deepEqual(r, ["raw fallback text"]);
  assert.equal(calls, 6);
});

test("extractMemories falls back to raw text on invalid JSON", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return chatCompletion("not json at all"); });
  const r = await mem.extractMemories("raw fallback text");
  assert.deepEqual(r, ["raw fallback text"]);
  assert.equal(calls, 2);
});

test("extractMemories truncates long raw fallback", async (t) => {
  const longText = "x".repeat(5000);
  t.mock.method(globalThis, "fetch", async () => chatCompletion("not json at all"));
  const r = await mem.extractMemories(longText);
  assert.equal(r.length, 1);
  assert.equal(r[0].length, 2000 + "... (truncated)".length);
  assert.ok(r[0].endsWith("... (truncated)"));
});

test("extractMemories falls back to raw text when LLM fails", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed"); });
  const r = await mem.extractMemories("some text");
  assert.deepEqual(r, ["some text"]);
});

test("llm throws on empty response content", async (t) => {
  t.mock.method(globalThis, "fetch", async () => chatCompletion(""));
  await assert.rejects(mem.llm([{ role: "user", content: "hi" }]), /LLM returned empty response/);
});

test("embed parses embedding response", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 })
  );
  const r = await mem.embed("hello");
  assert.deepEqual(r, [0.1, 0.2, 0.3]);
});

test("embed throws on empty embedding response", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ data: [] }), { status: 200 })
  );
  await assert.rejects(mem.embed("hello"), /Embed API returned empty response/);
});

test("fetch timeouts abort the request", async (t) => {
  mock.method(globalThis, "fetch", () => new Promise((_, reject) => reject(new DOMException("Aborted", "AbortError"))));
  await assert.rejects(mem.llm([{ role: "user", content: "hi" }]), /AbortError|fetch|LLM/);
  mock.restoreAll();
});

test("updateMemory rejects input over MAX_INPUT", async () => {
  await assert.rejects(mem.updateMemory("id-1", "x".repeat(50001)), /Input too long/);
});

test("decideAction: below threshold inserts", () => {
  assert.equal(mem.decideAction(0.5, 0.85, 0.99), "inserted");
});

test("decideAction: at threshold merges", () => {
  assert.equal(mem.decideAction(0.85, 0.85, 0.99), "merged");
  assert.equal(mem.decideAction(0.9, 0.85, 0.99), "merged");
});

test("decideAction: at skip threshold skips", () => {
  assert.equal(mem.decideAction(0.99, 0.85, 0.99), "skipped");
  assert.equal(mem.decideAction(1, 0.85, 0.99), "skipped");
});

test("decideAction: custom thresholds honored", () => {
  assert.equal(mem.decideAction(0.8, 0.8, 0.95), "merged");
  assert.equal(mem.decideAction(0.79, 0.8, 0.95), "inserted");
});

test("mergeTexts joins with a single space", () => {
  assert.equal(mem.mergeTexts("first fact", "second fact"), "first fact second fact");
  assert.equal(mem.mergeTexts("  first  ", " second "), "first second");
});

test("mergeTexts dedupes repeated sentences case-insensitively", () => {
  assert.equal(
    mem.mergeTexts("The sky is blue. I like coffee.", "I LIKE COFFEE. The sky is blue."),
    "The sky is blue. I like coffee."
  );
});

test("mergeTexts dedupes repeats that differ only by trailing punctuation", () => {
  assert.equal(mem.mergeTexts("first fact", "first fact."), "first fact");
  assert.equal(mem.mergeTexts("first fact!", "FIRST FACT"), "first fact!");
});

test("addMemoriesRaw rejects invalid threshold and dedup before any API call", async () => {
  let called = false;
  const originalFetch = globalThis.fetch.bind(globalThis);
  const m = mock.method(globalThis, "fetch", async () => { called = true; return originalFetch("http://x"); });
  try {
    await assert.rejects(mem.addMemoriesRaw("some text", undefined, { threshold: 0 }), /threshold must be a number between 0 and 1/);
    await assert.rejects(mem.addMemoriesRaw("some text", undefined, { threshold: 1 }), /threshold must be a number between 0 and 1/);
    await assert.rejects(mem.addMemoriesRaw("some text", undefined, { dedup: "yes" }), /dedup must be a boolean/);
    assert.equal(called, false);
  } finally {
    m.mock.restore();
  }
});

test("toRecord maps payload fields", () => {
  const rec = mem.toRecord({
    id: "abc-123",
    payload: { text: "hello", project: "proj", source: "chat", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z", expires_at: "2026-02-01T00:00:00.000Z", importance: 0.7 },
  });
  assert.deepEqual(rec, {
    id: "abc-123",
    text: "hello",
    project: "proj",
    source: "chat",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    expires_at: "2026-02-01T00:00:00.000Z",
    importance: 0.7,
  });
});

test("toRecord defaults for missing metadata", () => {
  const rec = mem.toRecord({ id: "1", payload: { text: "only text" } });
  assert.deepEqual(rec, { id: "1", text: "only text" });
});

test("batchAddMemories rejects an empty items array", async () => {
  await assert.rejects(mem.batchAddMemories([]), /items must be a non-empty array/);
});

test("importMemories rejects invalid JSON", async () => {
  await assert.rejects(mem.importMemories("not json"), /data must be valid JSON/);
});

test("importMemories rejects non-array shapes", async () => {
  await assert.rejects(mem.importMemories("{}"), /array of memories or an export envelope/);
  await assert.rejects(mem.importMemories('{"foo": 1}'), /array of memories or an export envelope/);
});

test("importMemories rejects oversized imports", async () => {
  const big = JSON.stringify({ memories: Array.from({ length: 10001 }, (_, i) => ({ text: `m${i}` })) });
  await assert.rejects(mem.importMemories(big), /Too many items/);
});
