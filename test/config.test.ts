import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEYS = [
  "MEMORYHUB_DIR", "MEMORYHUB_CONFIG", "QDRANT_URL", "MEMORYHUB_COLLECTION",
  "MEMORYHUB_VECTOR_SIZE", "MEMORYHUB_RETRY_DELAY_MS", "LLM_MODEL", "LLM_BASE",
  "LLM_BASE_URL", "LLM_KEY", "LLM_API_KEY", "EMBED_MODEL", "EMBED_BASE",
  "EMBED_BASE_URL", "EMBED_KEY", "EMBED_API_KEY", "MEMORYHUB_API_TOKEN",
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
  assert.equal(c.getConfig("QDRANT_URL"), "http://localhost:6333");
  assert.equal(c.getConfig("COLLECTION"), "memories");
  assert.equal(Number(c.getConfig("VECTOR_SIZE")), 768);
  assert.equal(c.getConfig("LLM_MODEL"), "");
  assert.equal(Number(c.getConfig("RETRY_DELAY_MS")), 1000);
  assert.equal(c.getConfig("DEDUP_ENABLED"), "true");
  assert.equal(c.getConfig("DEDUP_THRESHOLD"), "0.85");
  assert.equal(c.getConfig("DEDUP_SKIP_THRESHOLD"), "0.99");
});

test("env vars take precedence over config file", async () => {
  const file = tempConfigFile({ qdrant: { url: "http://file:6333" }, collection: "file-col" });
  const c = await freshConfig({
    MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")),
    MEMORYHUB_CONFIG: file,
    QDRANT_URL: "http://env:6333",
    MEMORYHUB_COLLECTION: "env-col",
  });
  assert.equal(c.getConfig("QDRANT_URL"), "http://env:6333");
  assert.equal(c.getConfig("COLLECTION"), "env-col");
});

test("config file is used when env is unset", async () => {
  const file = tempConfigFile({ qdrant: { url: "http://file:6333" }, collection: "file-col" });
  const c = await freshConfig({ MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")), MEMORYHUB_CONFIG: file });
  assert.equal(c.getConfig("QDRANT_URL"), "http://file:6333");
  assert.equal(c.getConfig("COLLECTION"), "file-col");
});

test("long env aliases are supported", async () => {
  const c = await freshConfig({
    MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")),
    LLM_BASE_URL: "http://llm.example.com",
    LLM_API_KEY: "long-alias-key",
  });
  assert.equal(c.getConfig("LLM_BASE"), "http://llm.example.com");
  assert.equal(c.getConfig("LLM_KEY"), "long-alias-key");
});

test("empty string env values are honored, not treated as unset", async () => {
  const c = await freshConfig({
    MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")),
    QDRANT_URL: "",
  });
  assert.equal(c.getConfig("QDRANT_URL"), "");
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

test("reloadConfig picks up config file edits", async () => {
  const file = tempConfigFile({ qdrant: { url: "http://old:6333" } });
  const c = await freshConfig({ MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")), MEMORYHUB_CONFIG: file });
  assert.equal(c.getConfig("QDRANT_URL"), "http://old:6333");
  writeFileSync(file, JSON.stringify({ qdrant: { url: "http://new:6333" }, llm: { model: "gpt-new" } }));
  const changed = c.reloadConfig();
  assert.equal(c.getConfig("QDRANT_URL"), "http://new:6333");
  assert.equal(c.getConfig("LLM_MODEL"), "gpt-new");
  assert.ok(changed.includes("QDRANT_URL"));
  assert.ok(changed.includes("LLM_MODEL"));
});

test("reloadConfig keeps previous values when file becomes corrupt", async () => {
  const file = tempConfigFile({ qdrant: { url: "http://old:6333" } });
  const c = await freshConfig({ MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")), MEMORYHUB_CONFIG: file });
  assert.equal(c.getConfig("QDRANT_URL"), "http://old:6333");
  writeFileSync(file, "{not valid json");
  assert.doesNotThrow(() => c.reloadConfig());
  assert.equal(c.getConfig("QDRANT_URL"), "http://old:6333");
});

test("reloadConfig keeps runtime overrides on top of file edits", async () => {
  const file = tempConfigFile({ qdrant: { url: "http://old:6333" } });
  const c = await freshConfig({ MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")), MEMORYHUB_CONFIG: file });
  c.setConfig("QDRANT_URL", "http://override:6333");
  writeFileSync(file, JSON.stringify({ qdrant: { url: "http://new:6333" } }));
  c.reloadConfig();
  assert.equal(c.getConfig("QDRANT_URL"), "http://override:6333");
});

test("reloadConfig applies file edits and fires change listeners", async () => {
  const file = tempConfigFile({ llm: { model: "gpt-old" } });
  const c = await freshConfig({ MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")), MEMORYHUB_CONFIG: file });
  const seen: string[][] = [];
  c.onConfigChange((keys) => seen.push(keys));
  writeFileSync(file, JSON.stringify({ llm: { model: "gpt-new", base_url: "http://llm:2" } }));
  c.reloadConfig();
  assert.deepEqual(seen, [["LLM_MODEL", "LLM_BASE"]]);
});

test("retry_delay_ms is read from config file", async () => {
  const file = tempConfigFile({ retry_delay_ms: 42 });
  const c = await freshConfig({ MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")), MEMORYHUB_CONFIG: file });
  assert.equal(c.getConfig("RETRY_DELAY_MS"), "42");
});

test("dedup settings are read from config file", async () => {
  const file = tempConfigFile({ dedup: { enabled: false, threshold: 0.9, skip_threshold: 0.97 } });
  const c = await freshConfig({ MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")), MEMORYHUB_CONFIG: file });
  assert.equal(c.getConfig("DEDUP_ENABLED"), "false");
  assert.equal(c.getConfig("DEDUP_THRESHOLD"), "0.9");
  assert.equal(c.getConfig("DEDUP_SKIP_THRESHOLD"), "0.97");
});

test("MEMORYHUB_DEDUP_* env vars override config file", async () => {
  const file = tempConfigFile({ dedup: { threshold: 0.9 } });
  const c = await freshConfig({
    MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")),
    MEMORYHUB_CONFIG: file,
    MEMORYHUB_DEDUP_THRESHOLD: "0.75",
  });
  assert.equal(c.getConfig("DEDUP_THRESHOLD"), "0.75");
});

test("setConfig validates dedup keys", async () => {
  const c = await freshConfig({ MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")) });
  assert.throws(() => c.setConfig("DEDUP_ENABLED", "yes"), /DEDUP_ENABLED must be "true" or "false"/);
  assert.doesNotThrow(() => c.setConfig("DEDUP_ENABLED", "false"));
  assert.throws(() => c.setConfig("DEDUP_THRESHOLD", "1.5"), /DEDUP_THRESHOLD must be a number between 0 and 1/);
  assert.throws(() => c.setConfig("DEDUP_THRESHOLD", "0"), /DEDUP_THRESHOLD must be a number between 0 and 1/);
  assert.throws(() => c.setConfig("DEDUP_THRESHOLD", "abc"), /DEDUP_THRESHOLD must be a number between 0 and 1/);
  assert.doesNotThrow(() => c.setConfig("DEDUP_THRESHOLD", "0.85"));
  assert.throws(() => c.setConfig("DEDUP_SKIP_THRESHOLD", "1"), /DEDUP_SKIP_THRESHOLD must be a number between 0 and 1/);
});

test("persistConfig writes the key to the config file atomically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memoryhub-test-"));
  const file = join(dir, "config.json");
  const c = await freshConfig({ MEMORYHUB_DIR: dir, MEMORYHUB_CONFIG: file });
  const path = c.persistConfig("LLM_MODEL", "gpt-persisted");
  assert.equal(path, file);
  const onDisk = JSON.parse(readFileSync(file, "utf-8"));
  assert.deepEqual(onDisk, { llm: { model: "gpt-persisted" } });
  assert.equal(c.getConfig("LLM_MODEL"), "gpt-persisted");
  assert.ok(!existsSync(`${file}.tmp-`), "no temp file left behind");
});

test("persistConfig writes the config file with 0600 permissions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memoryhub-test-"));
  const file = join(dir, "config.json");
  const c = await freshConfig({ MEMORYHUB_DIR: dir, MEMORYHUB_CONFIG: file });
  c.persistConfig("LLM_KEY", "very-secret-persisted-key");
  const mode = Number((await import("node:fs")).statSync(file).mode & 0o777);
  assert.equal(mode, 0o600);
});

test("persistConfig writes to the active config source when it differs from the default path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memoryhub-test-"));
  const active = join(dir, "active.json");
  const c = await freshConfig({ MEMORYHUB_DIR: dir, MEMORYHUB_CONFIG: active });
  c.persistConfig("COLLECTION", "active-col");
  assert.equal(c.persistConfig("RETRY_DELAY_MS", "250"), active);
  const onDisk = JSON.parse(readFileSync(active, "utf-8"));
  assert.equal(onDisk.collection, "active-col");
  assert.equal(onDisk.retry_delay_ms, 250);
  assert.equal(c.getConfig("RETRY_DELAY_MS"), "250");
});

test("API_TOKEN is read from env and config file, and masked", async () => {
  const c1 = await freshConfig({ MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")), MEMORYHUB_API_TOKEN: "env-token-12345678" });
  assert.equal(c1.getConfig("API_TOKEN"), "env-token-12345678");
  assert.equal(c1.getAllConfig().API_TOKEN, "env-****5678");
  const file = tempConfigFile({ api_token: "file-token-12345678" });
  const c2 = await freshConfig({ MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")), MEMORYHUB_CONFIG: file });
  assert.equal(c2.getConfig("API_TOKEN"), "file-token-12345678");
  c2.persistConfig("API_TOKEN", "persisted-token-12345678");
  assert.equal(c2.getConfig("API_TOKEN"), "persisted-token-12345678");
});

test("persistConfig with empty API_TOKEN removes it from the config file", async () => {
  const file = tempConfigFile({ api_token: "old-token-12345678", collection: "keep" });
  const c = await freshConfig({ MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")), MEMORYHUB_CONFIG: file });
  c.persistConfig("API_TOKEN", "");
  const onDisk = JSON.parse(readFileSync(file, "utf-8"));
  assert.equal(onDisk.api_token, undefined);
  assert.equal(onDisk.collection, "keep");
  assert.equal(c.getConfig("API_TOKEN"), "");
});

test("persistConfig merges into an existing config file", async () => {
  const file = tempConfigFile({ qdrant: { url: "http://keep:6333" }, llm: { model: "old" } });
  const c = await freshConfig({ MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")), MEMORYHUB_CONFIG: file });
  c.persistConfig("LLM_MODEL", "gpt-new");
  c.persistConfig("RETRY_DELAY_MS", "250");
  const onDisk = JSON.parse(readFileSync(file, "utf-8"));
  assert.equal(onDisk.qdrant.url, "http://keep:6333");
  assert.equal(onDisk.llm.model, "gpt-new");
  assert.equal(onDisk.retry_delay_ms, 250);
});

test("persistConfig writes numeric and boolean shapes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memoryhub-test-"));
  const file = join(dir, "config.json");
  const c = await freshConfig({ MEMORYHUB_DIR: dir, MEMORYHUB_CONFIG: file });
  c.persistConfig("VECTOR_SIZE", "3072");
  c.persistConfig("DEDUP_ENABLED", "false");
  c.persistConfig("DEDUP_THRESHOLD", "0.9");
  const onDisk = JSON.parse(readFileSync(file, "utf-8"));
  assert.equal(onDisk.vector_size, 3072);
  assert.equal(onDisk.dedup.enabled, false);
  assert.equal(onDisk.dedup.threshold, 0.9);
});

test("persistConfig rejects unknown keys and bad values", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memoryhub-test-"));
  const file = join(dir, "config.json");
  const c = await freshConfig({ MEMORYHUB_DIR: dir, MEMORYHUB_CONFIG: file });
  assert.throws(() => c.persistConfig("BOGUS", "x"), /Unknown config key "BOGUS"/);
  assert.throws(() => c.persistConfig("QDRANT_URL", "not-a-url"), /QDRANT_URL must be a valid http\(s\) URL/);
  assert.ok(!existsSync(file), "no file written on failed persist");
});

test("persistConfig survives reload (hot reload picks it up)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memoryhub-test-"));
  const file = join(dir, "config.json");
  const c = await freshConfig({ MEMORYHUB_DIR: dir, MEMORYHUB_CONFIG: file });
  c.persistConfig("COLLECTION", "persisted-col");
  c.reloadConfig();
  assert.equal(c.getConfig("COLLECTION"), "persisted-col");
});

test("unparseable config file warns only once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memoryhub-test-"));
  const file = join(dir, "config.json");
  writeFileSync(file, "{not valid json");
  const c = await freshConfig({ MEMORYHUB_DIR: mkdtempSync(join(tmpdir(), "memoryhub-test-")), MEMORYHUB_CONFIG: file });
  const errors: string[] = [];
  const orig = console.error;
  console.error = (m: unknown) => errors.push(String(m));
  try {
    c.reloadConfig();
    c.reloadConfig();
  } finally {
    console.error = orig;
  }
  assert.equal(errors.filter((e) => e.includes("ignoring unparseable")).length, 0);
});

test("unparseable config in chain falls back to next path without repeated warnings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memoryhub-test-"));
  const corrupt = join(dir, "bad.json");
  writeFileSync(corrupt, "{bad");
  const good = join(dir, "config.json");
  writeFileSync(good, JSON.stringify({ qdrant: { url: "http://fallback:6333" } }));
  const c = await freshConfig({ MEMORYHUB_DIR: dir, MEMORYHUB_CONFIG: corrupt });
  assert.equal(c.getConfig("QDRANT_URL"), "http://fallback:6333");
  const errors: string[] = [];
  const orig = console.error;
  console.error = (m: unknown) => errors.push(String(m));
  try {
    c.reloadConfig();
    c.reloadConfig();
    c.reloadConfig();
  } finally {
    console.error = orig;
  }
  assert.equal(errors.filter((e) => e.includes("ignoring unparseable")).length, 0);
});
