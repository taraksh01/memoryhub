import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface MemoryHubConfig {
  qdrant?: { url?: string };
  collection?: string;
  vector_size?: number;
  llm?: { model?: string; base_url?: string; api_key?: string };
  embedder?: { model?: string; base_url?: string; api_key?: string };
}

function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v !== undefined ? v : fallback;
}

export const MEMORYHUB_DIR = env("MEMORYHUB_DIR", join(homedir(), ".memoryhub"));

function configPaths(): string[] {
  return [
    process.env.MEMORYHUB_CONFIG,
    join(process.cwd(), "memoryhub.json"),
    join(MEMORYHUB_DIR, "config.json"),
  ].filter(Boolean) as string[];
}

function parseConfigFile(p: string): MemoryHubConfig | null {
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
}

function loadConfigFile(): { path: string; config: MemoryHubConfig } | null {
  for (const p of configPaths()) {
    if (existsSync(p)) {
      const parsed = parseConfigFile(p);
      if (parsed !== null) return { path: p, config: parsed };
      console.error(`memoryhub: warning: ignoring unparseable config file ${p}`);
    }
  }
  return null;
}

let fileSource: { path: string; config: MemoryHubConfig } | null = loadConfigFile();
let lastCorruptWarned = false;

const overrides: Record<string, string> = {};

const VALID_KEYS = new Set(["QDRANT_URL", "COLLECTION", "VECTOR_SIZE", "LLM_MODEL", "LLM_BASE", "LLM_KEY", "EMBED_MODEL", "EMBED_BASE", "EMBED_KEY", "RETRY_DELAY_MS"]);

const DEFAULTS: Record<string, string> = {
  QDRANT_URL: "http://localhost:6333",
  COLLECTION: "memories",
  VECTOR_SIZE: "768",
  LLM_MODEL: "",
  LLM_BASE: "",
  LLM_KEY: "",
  EMBED_MODEL: "",
  EMBED_BASE: "",
  EMBED_KEY: "",
  RETRY_DELAY_MS: "1000",
};

function envValue(key: string): string | undefined {
  const e = process.env;
  switch (key) {
    case "QDRANT_URL": return e.QDRANT_URL;
    case "COLLECTION": return e.MEMORYHUB_COLLECTION;
    case "VECTOR_SIZE": { const v = e.MEMORYHUB_VECTOR_SIZE; const n = Number(v); return v !== undefined && !isNaN(n) ? String(n) : undefined; }
    case "LLM_MODEL": return e.LLM_MODEL;
    case "LLM_BASE": return e.LLM_BASE ?? e.LLM_BASE_URL;
    case "LLM_KEY": return e.LLM_KEY ?? e.LLM_API_KEY;
    case "EMBED_MODEL": return e.EMBED_MODEL;
    case "EMBED_BASE": return e.EMBED_BASE ?? e.EMBED_BASE_URL;
    case "EMBED_KEY": return e.EMBED_KEY ?? e.EMBED_API_KEY;
    case "RETRY_DELAY_MS": { const v = e.MEMORYHUB_RETRY_DELAY_MS; const n = Number(v); return v !== undefined && !isNaN(n) ? String(n) : undefined; }
  }
  return undefined;
}

function fileValue(key: string): string | undefined {
  const c = fileSource?.config;
  if (!c) return undefined;
  switch (key) {
    case "QDRANT_URL": return c.qdrant?.url;
    case "COLLECTION": return c.collection;
    case "VECTOR_SIZE": return typeof c.vector_size === "number" ? String(c.vector_size) : undefined;
    case "LLM_MODEL": return c.llm?.model;
    case "LLM_BASE": return c.llm?.base_url;
    case "LLM_KEY": return c.llm?.api_key;
    case "EMBED_MODEL": return c.embedder?.model;
    case "EMBED_BASE": return c.embedder?.base_url;
    case "EMBED_KEY": return c.embedder?.api_key;
    case "RETRY_DELAY_MS": return undefined;
  }
  return undefined;
}

export function getConfig(key: string): string {
  if (key in overrides) return overrides[key];
  if (!VALID_KEYS.has(key)) {
    console.error(`memoryhub: unknown config key "${key}"`);
    return "";
  }
  return envValue(key) ?? fileValue(key) ?? DEFAULTS[key];
}

export function validateValue(key: string, value: string): void {
  const v = value.trim();
  if (!v) throw new Error(`${key} must not be empty`);
  switch (key) {
    case "QDRANT_URL":
    case "LLM_BASE":
    case "EMBED_BASE": {
      let parsed: URL;
      try { parsed = new URL(v); } catch { throw new Error(`${key} must be a valid http(s) URL, got "${value}"`); }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`${key} must be a valid http(s) URL, got "${value}"`);
      }
      break;
    }
    case "VECTOR_SIZE": {
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`VECTOR_SIZE must be a positive integer, got "${value}"`);
      break;
    }
    case "RETRY_DELAY_MS": {
      const n = Number(v);
      if (isNaN(n) || n < 0) throw new Error(`RETRY_DELAY_MS must be a non-negative number, got "${value}"`);
      break;
    }
  }
}

export function setConfig(key: string, value: string): void {
  if (!VALID_KEYS.has(key)) throw new Error(`Unknown config key "${key}". Valid keys: ${[...VALID_KEYS].join(", ")}`);
  validateValue(key, value);
  overrides[key] = value;
}

export function mask(val: string): string {
  if (!val || val.length < 8) return "****";
  return val.slice(0, 4) + "****" + val.slice(-4);
}

export function requireEmbedConfig(): void {
  if (!getConfig("EMBED_MODEL") || !getConfig("EMBED_BASE")) {
    throw new Error(
      "Embedding config missing. Set EMBED_MODEL + EMBED_BASE (or embedder.model + embedder.base_url in config.json). " +
      "These are separate from LLM config — embedding models cannot be used for chat and vice versa."
    );
  }
}

export function getAllConfig(): Record<string, string> {
  const sensitive = new Set(["LLM_KEY", "EMBED_KEY"]);
  const result: Record<string, string> = {};
  for (const k of VALID_KEYS) {
    const v = getConfig(k);
    result[k] = sensitive.has(k) ? mask(v) : v;
  }
  return result;
}

const changeListeners: ((changedKeys: string[]) => void)[] = [];

export function onConfigChange(fn: (changedKeys: string[]) => void): void {
  changeListeners.push(fn);
}

export function reloadConfig(): string[] {
  const before: Record<string, string> = {};
  for (const k of VALID_KEYS) before[k] = getConfig(k);

  const corruptPath = configPaths().find((p) => existsSync(p) && parseConfigFile(p) === null);
  if (corruptPath && fileSource?.path === corruptPath) {
    if (!lastCorruptWarned) {
      console.error(`memoryhub: warning: config file ${corruptPath} is unparseable — keeping previous values`);
      lastCorruptWarned = true;
    }
  } else {
    lastCorruptWarned = false;
    fileSource = loadConfigFile();
  }

  const changed = [...VALID_KEYS].filter((k) => getConfig(k) !== before[k]);
  if (changed.length > 0) {
    console.log(`memoryhub: config hot-reloaded (${changed.join(", ")})`);
    for (const fn of changeListeners) {
      try { fn(changed); } catch (e) { console.error(`memoryhub: config change handler failed: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }
  return changed;
}

const watcher = setInterval(() => reloadConfig(), 1000);
watcher.unref();