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

function envEither(a: string, b: string, fallback: string): string {
  const v = process.env[a] ?? process.env[b];
  return v !== undefined ? v : fallback;
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = Number(v);
  return isNaN(n) ? fallback : n;
}

export const MEMORYHUB_DIR = env("MEMORYHUB_DIR", join(homedir(), ".memoryhub"));

function loadConfig(): MemoryHubConfig {
  const paths = [
    process.env.MEMORYHUB_CONFIG,
    join(process.cwd(), "memoryhub.json"),
    join(MEMORYHUB_DIR, "config.json"),
  ].filter(Boolean) as string[];

  for (const p of paths) {
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, "utf-8")); } catch {}
    }
  }
  return {};
}

const cfg = loadConfig();

export const QDRANT_URL = env("QDRANT_URL", cfg.qdrant?.url ?? "http://localhost:6333");
export const COLLECTION = env("MEMORYHUB_COLLECTION", cfg.collection ?? "memories");
export const VECTOR_SIZE = num("MEMORYHUB_VECTOR_SIZE", cfg.vector_size ?? 768);
export const LLM_MODEL = env("LLM_MODEL", cfg.llm?.model ?? "");
export const LLM_BASE = envEither("LLM_BASE", "LLM_BASE_URL", cfg.llm?.base_url ?? "");
export const LLM_KEY = envEither("LLM_KEY", "LLM_API_KEY", cfg.llm?.api_key ?? "");
export const EMBED_MODEL = env("EMBED_MODEL", cfg.embedder?.model ?? "");
export const EMBED_BASE = envEither("EMBED_BASE", "EMBED_BASE_URL", cfg.embedder?.base_url ?? "");
export const EMBED_KEY = envEither("EMBED_KEY", "EMBED_API_KEY", cfg.embedder?.api_key ?? "");
export const RETRY_DELAY_MS = num("MEMORYHUB_RETRY_DELAY_MS", 1000);

const overrides: Record<string, string> = {};

const VALID_KEYS = new Set(["QDRANT_URL", "COLLECTION", "VECTOR_SIZE", "LLM_MODEL", "LLM_BASE", "LLM_KEY", "EMBED_MODEL", "EMBED_BASE", "EMBED_KEY", "RETRY_DELAY_MS"]);

export function getConfig(key: string): string {
  if (key in overrides) return overrides[key];
  if (!VALID_KEYS.has(key)) {
    console.error(`memoryhub: unknown config key "${key}"`);
    return "";
  }
  switch (key) {
    case "QDRANT_URL": return QDRANT_URL;
    case "COLLECTION": return COLLECTION;
    case "VECTOR_SIZE": return String(VECTOR_SIZE);
    case "LLM_MODEL": return LLM_MODEL;
    case "LLM_BASE": return LLM_BASE;
    case "LLM_KEY": return LLM_KEY;
    case "EMBED_MODEL": return EMBED_MODEL;
    case "EMBED_BASE": return EMBED_BASE;
    case "EMBED_KEY": return EMBED_KEY;
    case "RETRY_DELAY_MS": return String(RETRY_DELAY_MS);
  }
  return "";
}

export function setConfig(key: string, value: string): void {
  if (!VALID_KEYS.has(key)) throw new Error(`Unknown config key "${key}". Valid keys: ${[...VALID_KEYS].join(", ")}`);
  overrides[key] = value;
}

function mask(val: string): string {
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
