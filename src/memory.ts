import { QdrantClient } from "@qdrant/js-client-rest";
import { randomUUID } from "node:crypto";
import { getConfig, QDRANT_URL, COLLECTION, VECTOR_SIZE } from "./config.js";

const qdrant = new QdrantClient({ url: QDRANT_URL });

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

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= 3) throw e;
      const status = e instanceof Error && "status" in e ? (e as any).status : 0;
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
      const err = new Error(`LLM ${r.status}: ${body.slice(0, 300)}`);
      (err as any).status = r.status;
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
      const err = new Error(`Embed ${r.status}: ${body.slice(0, 300)}`);
      (err as any).status = r.status;
      throw err;
    }
    const d: EmbeddingResponse = await r.json();
    return d.data[0].embedding;
  });
}

async function extractMemories(text: string): Promise<string[]> {
  const raw = await llm([
    { role: "system", content: "Extract information worth remembering from the text. Use your judgment: keep related facts together in one string, split unrelated facts into separate strings. Return ONLY a JSON array of strings." },
    { role: "user", content: text },
  ]);
  const cleaned = raw.replace(/```json\s*|```\s*/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(`LLM returned invalid JSON: ${cleaned.slice(0, 200)}`);
  }
}

export async function ensureCollection() {
  const cols = await qdrant.getCollections();
  if (!cols.collections.some(c => c.name === COLLECTION)) {
    await qdrant.createCollection(COLLECTION, {
      vectors: { size: VECTOR_SIZE, distance: "Cosine" },
    });
  }
}

export async function addMemories(text: string) {
  const facts = await extractMemories(text);
  const points = [];
  for (const fact of facts) {
    const vector = await embed(fact);
    points.push({ id: randomUUID(), vector, payload: { text: fact, timestamp: Date.now() } });
  }
  if (points.length) await qdrant.upsert(getConfig("COLLECTION"), { points, wait: true });
  return JSON.stringify({ added: points.length, memories: facts }, null, 2);
}

export async function searchMemories(query: string, limit: number = 10) {
  const vector = await embed(query);
  const r = await qdrant.search(getConfig("COLLECTION"), { vector, limit, with_payload: true });
  return JSON.stringify(r.map(p => ({ id: p.id, text: (p.payload as any)?.text, score: p.score })), null, 2);
}

export async function listMemories(limit: number = 100, offset?: number) {
  const r = await qdrant.scroll(getConfig("COLLECTION"), { limit, offset, with_payload: true });
  return JSON.stringify({ memories: r.points.map(p => ({ id: p.id, text: (p.payload as any)?.text })), next_offset: r.next_page_offset }, null, 2);
}

export async function getMemory(memory_id: string) {
  const r = await qdrant.retrieve(getConfig("COLLECTION"), { ids: [memory_id], with_payload: true });
  if (!r.length) return JSON.stringify({ error: "Memory not found" });
  return JSON.stringify({ id: r[0].id, text: (r[0].payload as any)?.text }, null, 2);
}

export async function updateMemory(memory_id: string, text: string) {
  const vector = await embed(text);
  await qdrant.upsert(getConfig("COLLECTION"), { points: [{ id: memory_id, vector, payload: { text, timestamp: Date.now() } }], wait: true });
  return JSON.stringify({ updated: memory_id });
}

export async function deleteMemories(ids: string[]) {
  await qdrant.delete(getConfig("COLLECTION"), { points: ids });
  return JSON.stringify({ deleted: ids.length });
}

export async function deleteAllMemories() {
  await qdrant.delete(getConfig("COLLECTION"), { filter: {} });
  return JSON.stringify({ deleted: "all" });
}

export async function getStats() {
  const r = await qdrant.getCollection(getConfig("COLLECTION"));
  return JSON.stringify({ vectors_count: r.points_count, collection: getConfig("COLLECTION") }, null, 2);
}

export async function healthCheck(): Promise<string> {
  try {
    await qdrant.getCollections();
    return JSON.stringify({ status: "ok", qdrant: "connected" });
  } catch {
    return JSON.stringify({ status: "degraded", qdrant: "unreachable" });
  }
}
