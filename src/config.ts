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
  return process.env[key] || fallback;
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  return v !== undefined ? Number(v) : fallback;
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
      return JSON.parse(readFileSync(p, "utf-8"));
    }
  }
  return {};
}

const cfg = loadConfig();

export const QDRANT_URL = env("QDRANT_URL", cfg.qdrant?.url || "http://localhost:6333");
export const COLLECTION = env("MEMORYHUB_COLLECTION", cfg.collection || "memories");
export const VECTOR_SIZE = num("MEMORYHUB_VECTOR_SIZE", cfg.vector_size || 768);
export const LLM_MODEL = env("LLM_MODEL", cfg.llm?.model || "");
export const LLM_BASE = env("LLM_BASE_URL", cfg.llm?.base_url || "");
export const LLM_KEY = env("LLM_API_KEY", cfg.llm?.api_key || "");
export const EMBED_MODEL = env("EMBED_MODEL", cfg.embedder?.model || "");
export const EMBED_BASE = env("EMBED_BASE_URL", cfg.embedder?.base_url || "");
export const EMBED_KEY = env("EMBED_API_KEY", cfg.embedder?.api_key || "");

const overrides: Record<string, string> = {};

export function getConfig(key: string): string {
  if (key in overrides) return overrides[key];
  switch (key) {
    case "QDRANT_URL": return QDRANT_URL;
    case "COLLECTION": return COLLECTION;
    case "VECTOR_SIZE": return String(VECTOR_SIZE);
    case "LLM_MODEL": return LLM_MODEL;
    case "LLM_BASE": return LLM_BASE;
    case "LLM_KEY": return LLM_KEY;
    case "EMBED_MODEL": return EMBED_MODEL || getConfig("LLM_MODEL");
    case "EMBED_BASE": return EMBED_BASE || getConfig("LLM_BASE");
    case "EMBED_KEY": return EMBED_KEY || getConfig("LLM_KEY");
    default: return "";
  }
}

export function setConfig(key: string, value: string): void {
  overrides[key] = value;
}

export function getAllConfig(): Record<string, string> {
  const keys = ["QDRANT_URL", "COLLECTION", "VECTOR_SIZE", "LLM_MODEL", "LLM_BASE", "LLM_KEY", "EMBED_MODEL", "EMBED_BASE", "EMBED_KEY"];
  const result: Record<string, string> = {};
  for (const k of keys) result[k] = getConfig(k);
  return result;
}
