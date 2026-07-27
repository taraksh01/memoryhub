import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { QdrantClient } from "@qdrant/js-client-rest";
import { randomUUID } from "node:crypto";

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const COLLECTION = process.env.MEMORYHUB_COLLECTION || "memories";
const VECTOR_SIZE = Number(process.env.MEMORYHUB_VECTOR_SIZE) || 768;

const LLM_BASE = process.env.LLM_BASE_URL || "";
const LLM_KEY = process.env.LLM_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "";

const EMBED_BASE = process.env.EMBED_BASE_URL || "";
const EMBED_KEY = process.env.EMBED_API_KEY || "";
const EMBED_MODEL = process.env.EMBED_MODEL || "";

const qdrant = new QdrantClient({ url: QDRANT_URL });

interface ChatMessage {
  role: string;
  content: string;
}

interface ChatResponse {
  choices: { message: { content: string } }[];
  error?: { message: string };
}

interface EmbeddingResponse {
  data: { embedding: number[] }[];
  error?: { message: string };
}

interface MemoryPayload {
  text: string;
  timestamp: number;
}

interface ToolArgs {
  text?: string;
  query?: string;
  limit?: number;
  memory_id?: string;
  ids?: string[];
}

async function ensureCollection() {
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
  const d: ChatResponse = await r.json();
  if (!r.ok) throw new Error(d.error?.message || "LLM call failed");
  return d.choices[0].message.content;
}

async function embed(text: string): Promise<number[]> {
  const r = await fetch(`${EMBED_BASE}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${EMBED_KEY}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  const d: EmbeddingResponse = await r.json();
  if (!r.ok) throw new Error(d.error?.message || "Embedding call failed");
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

async function addMemories(text: string) {
  const facts = await extractMemories(text);
  const points = [];
  for (const fact of facts) {
    const vector = await embed(fact);
    points.push({ id: randomUUID(), vector, payload: { text: fact, timestamp: Date.now() } });
  }
  if (points.length) await qdrant.upsert(COLLECTION, { points, wait: true });
  return JSON.stringify({ added: points.length, memories: facts }, null, 2);
}

async function searchMemories(query: string, limit = 10) {
  const vector = await embed(query);
  const results = await qdrant.search(COLLECTION, { vector, limit, with_payload: true });
  const memories = results.map(r => ({ id: r.id, text: (r.payload as unknown as MemoryPayload).text, score: r.score }));
  return JSON.stringify({ results: memories }, null, 2);
}

async function listMemories() {
  const results = await qdrant.scroll(COLLECTION, { limit: 1000, with_payload: true });
  const memories = results.points.map(p => ({ id: p.id, text: (p.payload as unknown as MemoryPayload).text, timestamp: (p.payload as unknown as MemoryPayload).timestamp }));
  return JSON.stringify({ memories }, null, 2);
}

async function getMemory(id: string) {
  const results = await qdrant.retrieve(COLLECTION, { ids: [id], with_payload: true });
  if (!results.length) return JSON.stringify({ error: "Memory not found" });
  const p = results[0];
  return JSON.stringify({ id: p.id, text: (p.payload as unknown as MemoryPayload).text, timestamp: (p.payload as unknown as MemoryPayload).timestamp }, null, 2);
}

async function updateMemory(id: string, text: string) {
  const vector = await embed(text);
  await qdrant.upsert(COLLECTION, { points: [{ id, vector, payload: { text, timestamp: Date.now() } }], wait: true });
  return JSON.stringify({ id, text }, null, 2);
}

async function deleteMemories(ids: string[]) {
  await qdrant.delete(COLLECTION, { points: ids, wait: true });
  return JSON.stringify({ deleted: ids.length });
}

async function deleteAllMemories() {
  await qdrant.delete(COLLECTION, { filter: {}, wait: true });
  return JSON.stringify({ deleted: "all" });
}

async function getStats() {
  const info = await qdrant.getCollection(COLLECTION);
  return JSON.stringify({ total_memories: info.points_count, vector_size: VECTOR_SIZE }, null, 2);
}

const server = new Server({ name: "memoryhub", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "add_memories", description: "Store new memories from text. Extracts facts via LLM and stores them.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "search_memory", description: "Search memories by semantic similarity.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number", default: 10 } }, required: ["query"] } },
    { name: "list_memories", description: "List all stored memories.", inputSchema: { type: "object", properties: {} } },
    { name: "get_memory", description: "Get a specific memory by ID.", inputSchema: { type: "object", properties: { memory_id: { type: "string" } }, required: ["memory_id"] } },
    { name: "update_memory", description: "Update a memory by ID with new text.", inputSchema: { type: "object", properties: { memory_id: { type: "string" }, text: { type: "string" } }, required: ["memory_id", "text"] } },
    { name: "delete_memories", description: "Delete memories by IDs.", inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] } },
    { name: "delete_all_memories", description: "Delete all memories.", inputSchema: { type: "object", properties: {} } },
    { name: "memory_stats", description: "Get memory statistics.", inputSchema: { type: "object", properties: {} } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = args as ToolArgs;
  try {
    let result: string;
    switch (name) {
      case "add_memories": result = await addMemories(a.text!); break;
      case "search_memory": result = await searchMemories(a.query!, a.limit); break;
      case "list_memories": result = await listMemories(); break;
      case "get_memory": result = await getMemory(a.memory_id!); break;
      case "update_memory": result = await updateMemory(a.memory_id!, a.text!); break;
      case "delete_memories": result = await deleteMemories(a.ids!); break;
      case "delete_all_memories": result = await deleteAllMemories(); break;
      case "memory_stats": result = await getStats(); break;
      default: throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text: result }] };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
});

async function main() {
  await ensureCollection();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
