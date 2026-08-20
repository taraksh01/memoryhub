import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface MemoryHubConfig {
  qdrant?: { url?: string };
  collection?: string;
  vector_size?: number;
  retry_delay_ms?: number;
  api_token?: string;
  llm?: { model?: string; base_url?: string; api_key?: string };
  embedder?: { model?: string; base_url?: string; api_key?: string };
  dedup?: { enabled?: boolean; threshold?: number; skip_threshold?: number };
  session_idle_ms?: number;
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

const warnedUnparseable = new Set<string>();

function loadConfigFile(): { path: string; config: MemoryHubConfig } | null {
  for (const p of configPaths()) {
    if (existsSync(p)) {
      const parsed = parseConfigFile(p);
      if (parsed !== null) {
        if (warnedUnparseable.has(p)) warnedUnparseable.delete(p);
        return { path: p, config: parsed };
      }
      if (!warnedUnparseable.has(p)) {
        warnedUnparseable.add(p);
        console.error(`memoryhub: warning: ignoring unparseable config file ${p}`);
      }
    }
  }
  return null;
}

let fileSource: { path: string; config: MemoryHubConfig } | null = loadConfigFile();
let lastCorruptWarned = false;

const overrides: Record<string, string> = {};

const VALID_KEYS = new Set(["QDRANT_URL", "COLLECTION", "VECTOR_SIZE", "LLM_MODEL", "LLM_BASE", "LLM_KEY", "EMBED_MODEL", "EMBED_BASE", "EMBED_KEY", "RETRY_DELAY_MS", "DEDUP_ENABLED", "DEDUP_THRESHOLD", "DEDUP_SKIP_THRESHOLD", "API_TOKEN", "SESSION_IDLE_MS"]);

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
  DEDUP_ENABLED: "true",
  DEDUP_THRESHOLD: "0.85",
  DEDUP_SKIP_THRESHOLD: "0.99",
  API_TOKEN: "",
  SESSION_IDLE_MS: "0",
};

const invalidReads = new Set<string>();

function warnInvalid(key: string, value: string): void {
  const k = `${key}=${value}`;
  if (!invalidReads.has(k)) {
    invalidReads.add(k);
    console.error(`memoryhub: warning: ignoring invalid ${key} value "${value}"`);
  }
}

function numValue(key: string, raw: string | undefined, ok: (n: number) => boolean): string | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!isNaN(n) && ok(n)) return String(n);
  warnInvalid(key, raw);
  return undefined;
}

function urlValue(key: string, raw: string | undefined, honorEmpty: boolean): string | undefined {
  if (raw === undefined) return undefined;
  if (!raw && honorEmpty) return raw;
  if (!raw) {
    warnInvalid(key, raw);
    return undefined;
  }
  try {
    const p = new URL(raw);
    if (p.protocol === "http:" || p.protocol === "https:") return raw;
  } catch {}
  warnInvalid(key, raw);
  return undefined;
}

function envValue(key: string): string | undefined {
  const e = process.env;
  switch (key) {
    case "QDRANT_URL": return urlValue("QDRANT_URL", e.QDRANT_URL, false);
    case "COLLECTION": return e.MEMORYHUB_COLLECTION;
    case "VECTOR_SIZE": return numValue("VECTOR_SIZE", e.MEMORYHUB_VECTOR_SIZE, (n) => Number.isInteger(n) && n > 0);
    case "LLM_MODEL": return e.LLM_MODEL;
    case "LLM_BASE": return urlValue("LLM_BASE", e.LLM_BASE ?? e.LLM_BASE_URL, false);
    case "LLM_KEY": return e.LLM_KEY ?? e.LLM_API_KEY;
    case "EMBED_MODEL": return e.EMBED_MODEL;
    case "EMBED_BASE": return urlValue("EMBED_BASE", e.EMBED_BASE ?? e.EMBED_BASE_URL, false);
    case "EMBED_KEY": return e.EMBED_KEY ?? e.EMBED_API_KEY;
    case "RETRY_DELAY_MS": return numValue("RETRY_DELAY_MS", e.MEMORYHUB_RETRY_DELAY_MS, (n) => n >= 0);
    case "DEDUP_ENABLED": return e.MEMORYHUB_DEDUP_ENABLED;
    case "DEDUP_THRESHOLD": return numValue("DEDUP_THRESHOLD", e.MEMORYHUB_DEDUP_THRESHOLD, (n) => n > 0 && n < 1);
    case "DEDUP_SKIP_THRESHOLD": return numValue("DEDUP_SKIP_THRESHOLD", e.MEMORYHUB_DEDUP_SKIP_THRESHOLD, (n) => n > 0 && n < 1);
    case "API_TOKEN": return e.MEMORYHUB_API_TOKEN;
    case "SESSION_IDLE_MS": return numValue("SESSION_IDLE_MS", e.MEMORYHUB_SESSION_IDLE_MS, (n) => Number.isInteger(n) && n >= 0);
  }
  return undefined;
}

function fileValue(key: string): string | undefined {
  const c = fileSource?.config;
  if (!c) return undefined;
  switch (key) {
    case "QDRANT_URL": return urlValue("QDRANT_URL", c.qdrant?.url, false);
    case "COLLECTION": return c.collection;
    case "VECTOR_SIZE": return typeof c.vector_size === "number" ? numValue("VECTOR_SIZE", String(c.vector_size), (n) => Number.isInteger(n) && n > 0) : undefined;
    case "LLM_MODEL": return c.llm?.model;
    case "LLM_BASE": return urlValue("LLM_BASE", c.llm?.base_url, false);
    case "LLM_KEY": return c.llm?.api_key;
    case "EMBED_MODEL": return c.embedder?.model;
    case "EMBED_BASE": return urlValue("EMBED_BASE", c.embedder?.base_url, false);
    case "EMBED_KEY": return c.embedder?.api_key;
    case "RETRY_DELAY_MS": return typeof c.retry_delay_ms === "number" ? numValue("RETRY_DELAY_MS", String(c.retry_delay_ms), (n) => n >= 0) : undefined;
    case "DEDUP_ENABLED": return typeof c.dedup?.enabled === "boolean" ? String(c.dedup.enabled) : undefined;
    case "DEDUP_THRESHOLD": return typeof c.dedup?.threshold === "number" ? numValue("DEDUP_THRESHOLD", String(c.dedup.threshold), (n) => n > 0 && n < 1) : undefined;
    case "DEDUP_SKIP_THRESHOLD": return typeof c.dedup?.skip_threshold === "number" ? numValue("DEDUP_SKIP_THRESHOLD", String(c.dedup.skip_threshold), (n) => n > 0 && n < 1) : undefined;
    case "API_TOKEN": return c.api_token;
    case "SESSION_IDLE_MS": return typeof c.session_idle_ms === "number" ? numValue("SESSION_IDLE_MS", String(c.session_idle_ms), (n) => Number.isInteger(n) && n >= 0) : undefined;
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
    case "DEDUP_ENABLED": {
      if (v !== "true" && v !== "false") throw new Error(`DEDUP_ENABLED must be "true" or "false", got "${value}"`);
      break;
    }
    case "DEDUP_THRESHOLD":
    case "DEDUP_SKIP_THRESHOLD": {
      const n = Number(v);
      if (isNaN(n) || n <= 0 || n >= 1) throw new Error(`${key} must be a number between 0 and 1, got "${value}"`);
      break;
    }
    case "SESSION_IDLE_MS": {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) throw new Error(`SESSION_IDLE_MS must be a non-negative integer (milliseconds, 0 = never expire), got "${value}"`);
      break;
    }
  }
}

function isConfigPath(key: string): key is "QDRANT_URL" | "COLLECTION" | "VECTOR_SIZE" | "LLM_MODEL" | "LLM_BASE" | "LLM_KEY" | "EMBED_MODEL" | "EMBED_BASE" | "EMBED_KEY" | "RETRY_DELAY_MS" | "DEDUP_ENABLED" | "DEDUP_THRESHOLD" | "DEDUP_SKIP_THRESHOLD" | "API_TOKEN" | "SESSION_IDLE_MS" {
  return VALID_KEYS.has(key);
}

function applyKeyToConfig(config: MemoryHubConfig, key: string, value: string): void {
  switch (key) {
    case "QDRANT_URL": config.qdrant = { ...config.qdrant, url: value }; break;
    case "COLLECTION": config.collection = value; break;
    case "VECTOR_SIZE": config.vector_size = Number(value); break;
    case "LLM_MODEL": config.llm = { ...config.llm, model: value }; break;
    case "LLM_BASE": config.llm = { ...config.llm, base_url: value }; break;
    case "LLM_KEY": config.llm = { ...config.llm, api_key: value }; break;
    case "EMBED_MODEL": config.embedder = { ...config.embedder, model: value }; break;
    case "EMBED_BASE": config.embedder = { ...config.embedder, base_url: value }; break;
    case "EMBED_KEY": config.embedder = { ...config.embedder, api_key: value }; break;
    case "RETRY_DELAY_MS": config.retry_delay_ms = Number(value); break;
    case "DEDUP_ENABLED": config.dedup = { ...config.dedup, enabled: value === "true" }; break;
    case "DEDUP_THRESHOLD": config.dedup = { ...config.dedup, threshold: Number(value) }; break;
    case "DEDUP_SKIP_THRESHOLD": config.dedup = { ...config.dedup, skip_threshold: Number(value) }; break;
    case "API_TOKEN": config.api_token = value; break;
    case "SESSION_IDLE_MS": config.session_idle_ms = Number(value); break;
  }
}

function persistPath(): string {
  const p = process.env.MEMORYHUB_CONFIG;
  if (p) return p;
  return join(MEMORYHUB_DIR, "config.json");
}

export function persistConfig(key: string, value: string): string {
  if (!isConfigPath(key)) throw new Error(`Unknown config key "${key}". Valid keys: ${[...VALID_KEYS].join(", ")}`);
  const path = fileSource?.path ?? persistPath();
  let config: MemoryHubConfig = {};
  try { config = JSON.parse(readFileSync(path, "utf-8")); } catch { /* start fresh if missing or corrupt */ }
  if (key === "API_TOKEN" && value === "") {
    delete config.api_token;
  } else {
    validateValue(key, value);
    applyKeyToConfig(config, key, value);
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  fileSource = { path, config };
  return path;
}

export function setConfig(key: string, value: string): void {
  if (!VALID_KEYS.has(key)) throw new Error(`Unknown config key "${key}". Valid keys: ${[...VALID_KEYS].join(", ")}`);
  if (key === "API_TOKEN" && value === "") {
    delete overrides[key];
    return;
  }
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
  const sensitive = new Set(["LLM_KEY", "EMBED_KEY", "API_TOKEN"]);
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
    console.error(`memoryhub: config hot-reloaded (${changed.join(", ")})`);
    for (const fn of changeListeners) {
      try { fn(changed); } catch (e) { console.error(`memoryhub: config change handler failed: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }
  return changed;
}

const watcher = setInterval(() => reloadConfig(), 1000);
watcher.unref();