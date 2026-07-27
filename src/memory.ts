import { QdrantClient } from "@qdrant/js-client-rest";
import { randomUUID } from "node:crypto";
import { LLM_MODEL, LLM_BASE, LLM_KEY, EMBED_MODEL, EMBED_BASE, EMBED_KEY, QDRANT_URL, COLLECTION, VECTOR_SIZE } from "./config.js";

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

interface MemoryPayload {
  text: string;
  timestamp: number;
}

export async function ensureCollection() {
  const cols = await qdrant.getCollections();
  if (!cols.collections.some(c => c.name === COLLECTION)) {
    await qdrant.createCollection(COLLECTION, {
      vectors: { size: VECTOR_SIZE, distance: "Cosine" },
    });
  }
}

async function llm(messages: ChatMessage[]): Promise<string> {
  const r = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify({ model: LLM_MODEL, messages, temperature: 0.1, max_tokens: 2000 }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`LLM ${r.status}: ${body.slice(0, 300)}`);
  }
  const d: ChatResponse = await r.json();
  return d.choices[0].message.content;
}

async function embed(text: string): Promise<number[]> {
  const r = await fetch(`${EMBED_BASE}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${EMBED_KEY}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Embed ${r.status}: ${body.slice(0, 300)}`);
  }
  const d: EmbeddingResponse = await r.json();
  return d.data[0].embedding;
}

async function extractMemories(text: string): Promise<string[]> {
  const raw = await llm([
    { role: "system", content: "Extract factual statements worth remembering from the text. Return ONLY a JSON array of strings. Example: [\"User likes pizza.\", \"User lives in Tokyo.\"]" },
    { role: "user", content: text },
  ]);
  const cleaned = raw.replace(/```json\s*|```\s*/g, "").trim();
  return JSON.parse(cleaned);
}

export async function addMemories(text: string) {
  const facts = await extractMemories(text);
  const points = [];
  for (const fact of facts) {
    const vector = await embed(fact);
    points.push({ id: randomUUID(), vector, payload: { text: fact, timestamp: Date.now() } });
  }
  if (points.length) await qdrant.upsert(COLLECTION, { points, wait: true });
  return JSON.stringify({ added: points.length, memories: facts }, null, 2);
}

export async function searchMemories(query: string, limit = 10) {
  const vector = await embed(query);
  const results = await qdrant.search(COLLECTION, { vector, limit, with_payload: true });
  const memories = results.map(r => ({ id: r.id, text: (r.payload as unknown as MemoryPayload).text, score: r.score }));
  return JSON.stringify({ results: memories }, null, 2);
}

export async function listMemories() {
  const results = await qdrant.scroll(COLLECTION, { limit: 1000, with_payload: true });
  const memories = results.points.map(p => ({ id: p.id, text: (p.payload as unknown as MemoryPayload).text, timestamp: (p.payload as unknown as MemoryPayload).timestamp }));
  return JSON.stringify({ memories }, null, 2);
}

export async function getMemory(id: string) {
  const results = await qdrant.retrieve(COLLECTION, { ids: [id], with_payload: true });
  if (!results.length) return JSON.stringify({ error: "Memory not found" });
  const p = results[0];
  return JSON.stringify({ id: p.id, text: (p.payload as unknown as MemoryPayload).text, timestamp: (p.payload as unknown as MemoryPayload).timestamp }, null, 2);
}

export async function updateMemory(id: string, text: string) {
  const vector = await embed(text);
  await qdrant.upsert(COLLECTION, { points: [{ id, vector, payload: { text, timestamp: Date.now() } }], wait: true });
  return JSON.stringify({ id, text }, null, 2);
}

export async function deleteMemories(ids: string[]) {
  await qdrant.delete(COLLECTION, { points: ids, wait: true });
  return JSON.stringify({ deleted: ids.length });
}

export async function deleteAllMemories() {
  await qdrant.delete(COLLECTION, { filter: {}, wait: true });
  return JSON.stringify({ deleted: "all" });
}

export async function getStats() {
  const info = await qdrant.getCollection(COLLECTION);
  return JSON.stringify({ total_memories: info.points_count, vector_size: VECTOR_SIZE }, null, 2);
}
