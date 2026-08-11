import { QdrantClient } from "@qdrant/js-client-rest";
import { randomUUID } from "node:crypto";
import { getConfig, requireEmbedConfig } from "./config.js";

let _qdrant: QdrantClient | null = null;
let _qdrantUrl = "";

function qdrant(): QdrantClient {
  const url = getConfig("QDRANT_URL");
  if (!_qdrant || url !== _qdrantUrl) {
    _qdrant = new QdrantClient({ url, timeout: 30_000 });
    _qdrantUrl = url;
  }
  return _qdrant;
}

interface ChatMessage {
  role: string;
  content: string;
}

interface ChatResponse {
  choices: { message: { content: string } }[];
}

interface EmbeddingResponse {
  data: { embedding: number[] }[];
}

interface ErrorWithStatus extends Error {
  status: number;
}

function getStatus(e: unknown): number {
  return e instanceof Error && "status" in e ? (e as ErrorWithStatus).status : 0;
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= 3) throw e;
      const status = getStatus(e);
      if (status && status < 429) throw e;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

async function llm(messages: ChatMessage[]): Promise<string> {
  const base = getConfig("LLM_BASE");
  const key = getConfig("LLM_KEY");
  const model = getConfig("LLM_MODEL");
  return withRetry(async () => {
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, temperature: 0.1, max_tokens: 2000 }),
    });
    if (!r.ok) {
      const body = await r.text();
      const err = new Error(`LLM ${r.status}: ${body.slice(0, 300)}`) as ErrorWithStatus;
      err.status = r.status;
      throw err;
    }
    const d: ChatResponse = await r.json();
    return d.choices[0].message.content;
  });
}

async function embed(text: string): Promise<number[]> {
  const base = getConfig("EMBED_BASE");
  const key = getConfig("EMBED_KEY");
  const model = getConfig("EMBED_MODEL");
  return withRetry(async () => {
    const r = await fetch(`${base}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input: text }),
    });
    if (!r.ok) {
      const body = await r.text();
      const err = new Error(`Embed ${r.status}: ${body.slice(0, 300)}`) as ErrorWithStatus;
      err.status = r.status;
      throw err;
    }
    const d: EmbeddingResponse = await r.json();
    if (!d.data?.[0]?.embedding) throw new Error("Embed API returned empty response");
    return d.data[0].embedding;
  });
}

async function extractMemories(text: string): Promise<string[]> {
  let lastError: string = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await llm([
        { role: "system", content: "Extract information worth remembering from the text. Use your judgment: keep related facts together in one string, split unrelated facts into separate strings. Return ONLY a JSON array of strings." },
        { role: "user", content: text },
      ]);
      const cleaned = raw.replace(/```json\s*|```\s*/g, "").trim();
      let parsed: unknown;
      try { parsed = JSON.parse(cleaned); } catch {
        lastError = `invalid JSON: ${cleaned.slice(0, 200)}`;
        continue;
      }
      if (!Array.isArray(parsed) || !parsed.every(f => typeof f === "string")) {
        lastError = `non-array: ${cleaned.slice(0, 200)}`;
        continue;
      }
      return parsed;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  console.error(`memoryhub: LLM extraction failed (${lastError}) — storing raw text`);
  return [text];
}

export async function ensureCollection() {
  const cols = await qdrant().getCollections();
  const colName = getConfig("COLLECTION");
  const cfgSize = Number(getConfig("VECTOR_SIZE")) || 768;
  const existing = cols.collections.find(c => c.name === colName);
  if (!existing) {
    await qdrant().createCollection(colName, {
      vectors: { size: cfgSize, distance: "Cosine" },
    });
  } else {
    const info = await qdrant().getCollection(colName);
    const actual = info.config?.params?.vectors?.size;
    if (actual && actual !== cfgSize) {
      console.error(`memoryhub: collection "${colName}" has vector size ${actual}, but config specifies ${cfgSize}`);
    }
  }
}

const MAX_INPUT = 50_000;

export async function addMemories(text: string, project?: string) {
  if (text.length > MAX_INPUT) throw new Error(`Input too long (${text.length} chars, max ${MAX_INPUT})`);
  requireEmbedConfig();
  const facts = await extractMemories(text);
  const vectors = await Promise.all(facts.map(fact => embed(fact)));
  const points = facts.map((fact, i) => {
    const payload: Record<string, unknown> = { text: fact, timestamp: Date.now() };
    if (project) payload.project = project;
    return { id: randomUUID(), vector: vectors[i], payload };
  });
  if (points.length) await qdrant().upsert(getConfig("COLLECTION"), { points, wait: true });
  return JSON.stringify({ added: points.length, memories: facts }, null, 2);
}

export async function searchMemories(query: string, limit: number = 10, project?: string) {
  requireEmbedConfig();
  const vector = await embed(query);
  const filter = project ? { must: [{ key: "project", match: { value: project } }] } : undefined;
  const r = await qdrant().search(getConfig("COLLECTION"), { vector, limit: Math.max(1, limit), with_payload: true, filter });
  return JSON.stringify(r.map(p => ({ id: p.id, text: String(p.payload?.text ?? ""), score: p.score })), null, 2);
}

export async function listMemories(limit: number = 100, offset?: string, project?: string) {
  const filter = project ? { must: [{ key: "project", match: { value: project } }] } : undefined;
  const r = await qdrant().scroll(getConfig("COLLECTION"), { limit: Math.max(1, limit), offset, with_payload: true, filter });
  return JSON.stringify({ memories: r.points.map(p => ({ id: p.id, text: String(p.payload?.text ?? "") })), next_offset: r.next_page_offset }, null, 2);
}

export async function getMemory(memory_id: string) {
  const r = await qdrant().retrieve(getConfig("COLLECTION"), { ids: [memory_id], with_payload: true });
  if (!r.length) return JSON.stringify({ error: "Memory not found" });
  return JSON.stringify({ id: r[0].id, text: String(r[0].payload?.text ?? "") }, null, 2);
}

export async function updateMemory(memory_id: string, text: string) {
  requireEmbedConfig();
  const existing = await qdrant().retrieve(getConfig("COLLECTION"), { ids: [memory_id], with_payload: true });
  if (!existing.length) return JSON.stringify({ error: "Memory not found" });
  const vector = await embed(text);
  const oldProject = existing[0].payload?.project;
  const payload: Record<string, unknown> = { text, timestamp: Date.now() };
  if (oldProject) payload.project = oldProject;
  await qdrant().upsert(getConfig("COLLECTION"), { points: [{ id: memory_id, vector, payload }], wait: true });
  return JSON.stringify({ updated: memory_id });
}

export async function deleteMemories(ids: string[]) {
  await qdrant().delete(getConfig("COLLECTION"), { points: ids });
  return JSON.stringify({ deleted: ids.length });
}

export async function deleteAllMemories(project?: string) {
  const filter = project ? { must: [{ key: "project", match: { value: project } }] } : {};
  const countResp = await qdrant().count(getConfig("COLLECTION"), { filter });
  await qdrant().delete(getConfig("COLLECTION"), { filter });
  return JSON.stringify({ deleted: countResp.count ?? 0 });
}

export async function getStats() {
  const r = await qdrant().getCollection(getConfig("COLLECTION"));
  return JSON.stringify({ vectors_count: r.points_count, collection: getConfig("COLLECTION") }, null, 2);
}

export async function healthCheck(): Promise<string> {
  try {
    await qdrant().getCollections();
    return JSON.stringify({ status: "ok", qdrant: "connected" });
  } catch {
    return JSON.stringify({ status: "degraded", qdrant: "unreachable" });
  }
}
