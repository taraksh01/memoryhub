import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

type ConfigureModule = typeof import("../src/configure.ts");
const cfg = (await import("../src/configure.ts")) as ConfigureModule;

const tmp = () => mkdtempSync(join(tmpdir(), "memoryhub-cfg-"));

test("parseFlags parses repeated --set pairs", () => {
  const f = cfg.parseFlags(["--set", "QDRANT_URL=http://x:1", "--set", "LLM_MODEL=gpt-4o-mini"]);
  assert.deepEqual(f.sets, { QDRANT_URL: "http://x:1", LLM_MODEL: "gpt-4o-mini" });
  assert.equal(f.noVerify, false);
});

test("parseFlags supports --set=KEY=VALUE and --no-verify", () => {
  const f = cfg.parseFlags(["--set=EMBED_MODEL=text-embedding-3-small", "--no-verify"]);
  assert.equal(f.sets.EMBED_MODEL, "text-embedding-3-small");
  assert.equal(f.noVerify, true);
});

test("parseFlags supports --file with and without =", () => {
  assert.equal(cfg.parseFlags(["--file", "a.json"]).file, "a.json");
  assert.equal(cfg.parseFlags(["--file=b.json"]).file, "b.json");
});

test("parseFlags rejects unknown options", () => {
  assert.throws(() => cfg.parseFlags(["--bogus"]), /Unknown option: --bogus/);
});

test("parseFlags rejects --set without KEY=VALUE", () => {
  assert.throws(() => cfg.parseFlags(["--set", "JUST_A_KEY"]), /--set requires KEY=VALUE/);
  assert.throws(() => cfg.parseFlags(["--set"]), /--set requires KEY=VALUE/);
});

test("configFromFile maps the config file shape to keys", () => {
  const dir = tmp();
  const p = join(dir, "config.json");
  
  writeFileSync(p, JSON.stringify({
    qdrant: { url: "http://f:6333" },
    collection: "col",
    vector_size: 512,
    llm: { model: "m", base_url: "http://l", api_key: "k" },
    embedder: { model: "em", base_url: "http://e", api_key: "ek" },
  }));
  const v = cfg.configFromFile(p);
  assert.equal(v.QDRANT_URL, "http://f:6333");
  assert.equal(v.COLLECTION, "col");
  assert.equal(v.VECTOR_SIZE, "512");
  assert.equal(v.LLM_MODEL, "m");
  assert.equal(v.LLM_BASE, "http://l");
  assert.equal(v.LLM_KEY, "k");
  assert.equal(v.EMBED_MODEL, "em");
  assert.equal(v.EMBED_BASE, "http://e");
  assert.equal(v.EMBED_KEY, "ek");
});

test("configFromFile ignores unknown fields", () => {
  const dir = tmp();
  const p = join(dir, "config.json");
  
  writeFileSync(p, JSON.stringify({ future_field: 1, qdrant: { url: "http://f:6333" } }));
  const v = cfg.configFromFile(p);
  assert.deepEqual(v, { QDRANT_URL: "http://f:6333" });
});

test("configFromFile rejects malformed JSON", () => {
  const dir = tmp();
  const p = join(dir, "config.json");
  
  writeFileSync(p, "not json");
  assert.throws(() => cfg.configFromFile(p), /invalid JSON/);
});

test("writeConfigFile writes with 0600 permissions", () => {
  const dir = tmp();
  const p = join(dir, "config.json");
  cfg.writeConfigFile(p, { qdrant: { url: "http://x:6333" } });
  assert.ok(existsSync(p));
  const mode = statSync(p).mode & 0o777;
  assert.equal(mode, 0o600);
  const data = JSON.parse(readFileSync(p, "utf-8"));
  assert.equal(data.qdrant.url, "http://x:6333");
});

test("writeConfigFile merges instead of clobbering", () => {
  const dir = tmp();
  const p = join(dir, "config.json");
  cfg.writeConfigFile(p, { qdrant: { url: "http://a:6333" }, collection: "memories" });
  cfg.writeConfigFile(p, { llm: { model: "gpt-4o-mini" } });
  const data = JSON.parse(readFileSync(p, "utf-8")) as Record<string, any>;
  assert.equal(data.qdrant.url, "http://a:6333");
  assert.equal(data.collection, "memories");
  assert.equal(data.llm.model, "gpt-4o-mini");
});

test("writeConfigFile creates missing parent directories", () => {
  const dir = tmp();
  const p = join(dir, "nested", "deeper", "config.json");
  cfg.writeConfigFile(p, { collection: "memories" });
  assert.ok(existsSync(p));
});

test("buildConfig maps values to config shape and validates vector size", () => {
  const c = cfg.buildConfig({ QDRANT_URL: "http://x:6333", VECTOR_SIZE: "512", LLM_MODEL: "m", LLM_KEY: "k" });
  assert.deepEqual(c, { qdrant: { url: "http://x:6333" }, vector_size: 512, llm: { model: "m", api_key: "k" } });
  assert.throws(() => cfg.buildConfig({ VECTOR_SIZE: "abc" }), /VECTOR_SIZE must be a positive number/);
  assert.throws(() => cfg.buildConfig({ VECTOR_SIZE: "-5" }), /VECTOR_SIZE must be a positive number/);
});

test("verifySettings reports all checks passing", async (t) => {
  const { setConfig } = await import("../src/config.js");
  setConfig("QDRANT_URL", "http://qdrant:6333");
  setConfig("EMBED_MODEL", "text-embedding-3-small");
  setConfig("EMBED_BASE", "http://embed:1");
  setConfig("EMBED_KEY", "k");
  setConfig("LLM_MODEL", "gpt-4o-mini");
  setConfig("LLM_BASE", "http://llm:1");
  setConfig("LLM_KEY", "k");
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("/chat/completions")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 });
    }
    if (url.includes("/embeddings")) {
      return new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: { collections: [] } }), { status: 200, headers: { "server-version": "1.18.0" } });
  });
  const results = await cfg.verifySettings();
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
});

test("verifySettings reports failures", async (t) => {
  const { setConfig } = await import("../src/config.js");
  setConfig("QDRANT_URL", "http://qdrant:6333");
  setConfig("EMBED_MODEL", "text-embedding-3-small");
  setConfig("EMBED_BASE", "http://embed:1");
  setConfig("LLM_MODEL", "gpt-4o-mini");
  setConfig("LLM_BASE", "http://llm:1");
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("/chat/completions")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 });
    }
    if (url.includes("/embeddings")) {
      return new Response('{"error":"rate limited"}', { status: 429 });
    }
    return new Response(JSON.stringify({ result: { collections: [] } }), { status: 200, headers: { "server-version": "1.18.0" } });
  });
  const results = await cfg.verifySettings();
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.match(results[1].message, /429|rate/);
  assert.equal(results[2].ok, true);
  mock.restoreAll();
});
