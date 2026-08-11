import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEYS = [
  "MEMORYHUB_DIR", "MEMORYHUB_CONFIG", "QDRANT_URL", "MEMORYHUB_COLLECTION",
  "MEMORYHUB_VECTOR_SIZE", "MEMORYHUB_RETRY_DELAY_MS", "LLM_MODEL", "LLM_BASE",
  "LLM_BASE_URL", "LLM_KEY", "LLM_API_KEY", "EMBED_MODEL", "EMBED_BASE",
  "EMBED_BASE_URL", "EMBED_KEY", "EMBED_API_KEY",
];

type ConfigModule = typeof import("../src/config.ts");

let counter = 0;
async function freshConfig(env: Record<string, string | undefined>): Promise<ConfigModule> {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) process.env[k] = v;
  }
  const url = new URL(`../src/config.ts?t=${++counter}`, import.meta.url).href;
  return (await import(url)) as ConfigModule;
}

function tempConfigFile(cfg: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "memoryhub-test-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(cfg));
  return p;
}

test("defaults when no env or config set", async () => {
  const c = await freshConfig({ MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")) });
  assert.equal(c.QDRANT_URL, "http://localhost:6333");
  assert.equal(c.COLLECTION, "memories");
  assert.equal(c.VECTOR_SIZE, 768);
  assert.equal(c.LLM_MODEL, "");
  assert.equal(c.RETRY_DELAY_MS, 1000);
});

test("env vars take precedence over config file", async () => {
  const file = tempConfigFile({ qdrant: { url: "http://file:6333" }, collection: "file-col" });
  const c = await freshConfig({
    MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")),
    MEMORYHUB_CONFIG: file,
    QDRANT_URL: "http://env:6333",
    MEMORYHUB_COLLECTION: "env-col",
  });
  assert.equal(c.QDRANT_URL, "http://env:6333");
  assert.equal(c.COLLECTION, "env-col");
});

test("config file is used when env is unset", async () => {
  const file = tempConfigFile({ qdrant: { url: "http://file:6333" }, collection: "file-col" });
  const c = await freshConfig({ MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")), MEMORYHUB_CONFIG: file });
  assert.equal(c.QDRANT_URL, "http://file:6333");
  assert.equal(c.COLLECTION, "file-col");
});

test("long env aliases are supported", async () => {
  const c = await freshConfig({
    MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")),
    LLM_BASE_URL: "http://llm.example.com",
    LLM_API_KEY: "long-alias-key",
  });
  assert.equal(c.LLM_BASE, "http://llm.example.com");
  assert.equal(c.LLM_KEY, "long-alias-key");
});

test("empty string env values are honored, not treated as unset", async () => {
  const c = await freshConfig({
    MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")),
    QDRANT_URL: "",
  });
  assert.equal(c.QDRANT_URL, "");
});

test("getConfig returns override after setConfig with valid key", async () => {
  const c = await freshConfig({ MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")) });
  c.setConfig("QDRANT_URL", "http://override:6333");
  assert.equal(c.getConfig("QDRANT_URL"), "http://override:6333");
});

test("setConfig rejects unknown keys", async () => {
  const c = await freshConfig({ MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")) });
  assert.throws(() => c.setConfig("LLM_MODLE", "gpt-4"), /Unknown config key "LLM_MODLE"/);
});

test("setConfig rejects empty values", async () => {
  const c = await freshConfig({ MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")) });
  assert.throws(() => c.setConfig("QDRANT_URL", ""), /QDRANT_URL must not be empty/);
  assert.throws(() => c.setConfig("LLM_MODEL", "   "), /LLM_MODEL must not be empty/);
});

test("setConfig rejects malformed URLs", async () => {
  const c = await freshConfig({ MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")) });
  assert.throws(() => c.setConfig("QDRANT_URL", "not-a-url"), /QDRANT_URL must be a valid http\(s\) URL/);
  assert.throws(() => c.setConfig("LLM_BASE", "ftp://x:1"), /LLM_BASE must be a valid http\(s\) URL/);
  assert.doesNotThrow(() => c.setConfig("EMBED_BASE", "http://localhost:11434/v1"));
});

test("setConfig validates numeric keys", async () => {
  const c = await freshConfig({ MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")) });
  assert.throws(() => c.setConfig("VECTOR_SIZE", "abc"), /VECTOR_SIZE must be a positive integer/);
  assert.throws(() => c.setConfig("VECTOR_SIZE", "512.5"), /VECTOR_SIZE must be a positive integer/);
  assert.throws(() => c.setConfig("VECTOR_SIZE", "-5"), /VECTOR_SIZE must be a positive integer/);
  assert.doesNotThrow(() => c.setConfig("VECTOR_SIZE", "3072"));
  assert.throws(() => c.setConfig("RETRY_DELAY_MS", "-1"), /RETRY_DELAY_MS must be a non-negative number/);
  assert.doesNotThrow(() => c.setConfig("RETRY_DELAY_MS", "0"));
});

test("getConfig returns empty string for unknown keys", async () => {
  const c = await freshConfig({ MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")) });
  assert.equal(c.getConfig("BOGUS"), "");
});

test("requireEmbedConfig throws when embedding config missing", async () => {
  const c = await freshConfig({ MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")) });
  assert.throws(() => c.requireEmbedConfig(), /Embedding config missing/);
});

test("requireEmbedConfig passes when embedding config is set", async () => {
  const c = await freshConfig({
    MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")),
    EMBED_MODEL: "text-embedding-3-small",
    EMBED_BASE: "http://localhost:11434/v1",
  });
  assert.doesNotThrow(() => c.requireEmbedConfig());
});

test("getAllConfig masks API keys", async () => {
  const c = await freshConfig({
    MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")),
    LLM_KEY: "very-secret-key-1234",
    EMBED_KEY: "another-secret-key-5678",
  });
  const all = c.getAllConfig();
  assert.equal(all.LLM_KEY, "very****1234");
  assert.ok(!all.LLM_KEY.includes("secret"));
  assert.ok(!all.EMBED_KEY.includes("secret"));
});
