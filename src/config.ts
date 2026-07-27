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

function loadConfig(): MemoryHubConfig {
  const paths = [
    process.env.MEMORYHUB_CONFIG,
    join(process.cwd(), "memoryhub.json"),
    join(homedir(), ".memoryhub", "config.json"),
  ].filter(Boolean) as string[];

  for (const p of paths) {
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, "utf-8"));
    }
  }
  return {};
}

function env(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  return v !== undefined ? Number(v) : fallback;
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
