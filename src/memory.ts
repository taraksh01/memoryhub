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

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 60_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const delay = Number(getConfig("RETRY_DELAY_MS")) || 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= 3) throw e;
      const status = getStatus(e);
      if (status && status < 429) throw e;
      await new Promise(r => setTimeout(r, delay * attempt));
    }
  }
}

export async function llm(messages: ChatMessage[]): Promise<string> {
  const base = getConfig("LLM_BASE");
  const key = getConfig("LLM_KEY");
  const model = getConfig("LLM_MODEL");
  return withRetry(async () => {
    const r = await fetchWithTimeout(`${base}/chat/completions`, {
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
    const content = d.choices?.[0]?.message?.content;
    if (content == null || content === "") throw new Error("LLM returned empty response");
    return content;
  });
}

export async function embed(text: string): Promise<number[]> {
  const base = getConfig("EMBED_BASE");
  const key = getConfig("EMBED_KEY");
  const model = getConfig("EMBED_MODEL");
  return withRetry(async () => {
    const r = await fetchWithTimeout(`${base}/embeddings`, {
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

export async function extractMemories(text: string): Promise<string[]> {
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
  const truncated = text.length > 2000 ? text.slice(0, 2000) + "... (truncated)" : text;
  return [truncated];
}

function vectorSize(info: Awaited<ReturnType<QdrantClient["getCollection"]>>): number | undefined {
  const vectors = info.config?.params?.vectors;
  if (typeof vectors === "number") return vectors;
  if (vectors && typeof vectors === "object" && "size" in vectors) {
    const s = (vectors as { size?: unknown }).size;
    if (typeof s === "number") return s;
  }
  return undefined;
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
    const actual = vectorSize(info);
    if (actual && actual !== cfgSize) {
      throw new Error(
        `Collection "${colName}" has vector size ${actual}, but config specifies ${cfgSize}. ` +
        `Fix MEMORYHUB_VECTOR_SIZE or delete the collection.`
      );
    }
  }
}

const MAX_INPUT = 50_000;
const EMBED_CONCURRENCY = 5;
const MAX_SEARCH_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;

export interface AddOptions {
  source?: string;
  importance?: number;
  expires_at?: string;
  dedup?: boolean;
  threshold?: number;
}

export interface AddOutcome {
  id: string;
  text: string;
  action: "inserted" | "merged" | "skipped";
}

export interface UpdateOptions {
  source?: string;
  importance?: number;
  expires_at?: string;
}

export interface MemoryRecord {
  id: string;
  text: string;
  project?: string;
  source?: string;
  created_at?: string;
  updated_at?: string;
  expires_at?: string;
  importance?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function validateMetadata(opts: { source?: string; importance?: number; expires_at?: string }): void {
  if (opts.source !== undefined && (typeof opts.source !== "string" || !opts.source.trim())) {
    throw new Error("source must be a non-empty string");
  }
  if (opts.importance !== undefined) {
    if (typeof opts.importance !== "number" || isNaN(opts.importance) || opts.importance < 0 || opts.importance > 1) {
      throw new Error("importance must be a number between 0 and 1");
    }
  }
  if (opts.expires_at !== undefined) {
    if (typeof opts.expires_at !== "string" || isNaN(Date.parse(opts.expires_at))) {
      throw new Error("expires_at must be a valid ISO date string");
    }
  }
}

function basePayload(opts: AddOptions, now: string): Record<string, unknown> {
  const payload: Record<string, unknown> = { created_at: now, updated_at: now };
  if (opts.source) payload.source = opts.source;
  if (opts.importance !== undefined) payload.importance = opts.importance;
  if (opts.expires_at) payload.expires_at = opts.expires_at;
  return payload;
}

export function toRecord(p: { id: string | number; payload?: Record<string, unknown> | null }): MemoryRecord {
  const rec: MemoryRecord = {
    id: String(p.id),
    text: String(p.payload?.text ?? ""),
  };
  const payload = p.payload ?? {};
  if (payload.project !== undefined) rec.project = String(payload.project);
  if (payload.source !== undefined) rec.source = String(payload.source);
  if (payload.created_at !== undefined) rec.created_at = String(payload.created_at);
  if (payload.updated_at !== undefined) rec.updated_at = String(payload.updated_at);
  if (payload.expires_at !== undefined) rec.expires_at = String(payload.expires_at);
  if (payload.importance !== undefined) rec.importance = Number(payload.importance);
  return rec;
}

function projectFilter(project?: string): Record<string, unknown> | undefined {
  return project ? { must: [{ key: "project", match: { value: project } }] } : undefined;
}

export function decideAction(score: number, threshold: number, skipThreshold: number): "merged" | "skipped" | "inserted" {
  if (score >= skipThreshold) return "skipped";
  if (score >= threshold) return "merged";
  return "inserted";
}

export function mergeTexts(oldText: string, newText: string): string {
  return `${oldText.trim()} ${newText.trim()}`.trim();
}

async function findDuplicate(fact: string, vector: number[], project?: string): Promise<{ id: string; text: string; score: number } | null> {
  const r = await qdrant().query(getConfig("COLLECTION"), { query: vector, limit: 1, with_payload: true, filter: projectFilter(project) });
  const top = r.points[0];
  if (!top || typeof top.score !== "number") return null;
  return { id: String(top.id), text: String(top.payload?.text ?? ""), score: top.score };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function addMemories(text: string, project?: string, opts: AddOptions = {}) {
  if (text.length > MAX_INPUT) throw new Error(`Input too long (${text.length} chars, max ${MAX_INPUT})`);
  validateMetadata(opts);
  requireEmbedConfig();
  const facts = await extractMemories(text);
  const dedupEnabled = opts.dedup ?? getConfig("DEDUP_ENABLED") === "true";
  const threshold = opts.threshold ?? (Number(getConfig("DEDUP_THRESHOLD")) || 0.85);
  const skipThreshold = Number(getConfig("DEDUP_SKIP_THRESHOLD")) || 0.99;
  const now = nowIso();

  const outcomes: AddOutcome[] = [];
  await mapLimit(facts, EMBED_CONCURRENCY, async (fact) => {
    const vector = await embed(fact);
    if (dedupEnabled) {
      const dup = await findDuplicate(fact, vector, project);
      if (dup) {
        const action = decideAction(dup.score, threshold, skipThreshold);
        if (action === "skipped") {
          outcomes.push({ id: dup.id, text: fact, action });
          return;
        }
        if (action === "merged") {
          const mergedText = mergeTexts(dup.text, fact);
        const mergedVector = await embed(mergedText);
        const existing = await qdrant().retrieve(getConfig("COLLECTION"), { ids: [dup.id], with_payload: true });
        const oldPayload = (existing[0]?.payload ?? {}) as Record<string, unknown>;
        const payload: Record<string, unknown> = {
          ...basePayload(opts, now),
          text: mergedText,
          created_at: typeof oldPayload.created_at === "string" ? oldPayload.created_at : now,
        };
        if (oldPayload.project !== undefined) payload.project = oldPayload.project;
        else if (project) payload.project = project;
        if (typeof oldPayload.source === "string") payload.source = oldPayload.source;
        if (oldPayload.importance !== undefined) payload.importance = oldPayload.importance;
        if (typeof oldPayload.expires_at === "string") payload.expires_at = oldPayload.expires_at;
        await qdrant().upsert(getConfig("COLLECTION"), { points: [{ id: dup.id, vector: mergedVector, payload }], wait: true });
        outcomes.push({ id: dup.id, text: mergedText, action: "merged" });
        return;
      }
    }
    const payload: Record<string, unknown> = { ...basePayload(opts, now), text: fact };
    if (project) payload.project = project;
    const id = randomUUID();
    await qdrant().upsert(getConfig("COLLECTION"), { points: [{ id, vector, payload }], wait: true });
    outcomes.push({ id, text: fact, action: "inserted" });
    }
  });

  const added = outcomes.filter((o) => o.action === "inserted").length;
  const merged = outcomes.filter((o) => o.action === "merged").length;
  const skipped = outcomes.filter((o) => o.action === "skipped").length;
  return JSON.stringify({ added, merged, skipped, memories: outcomes }, null, 2);
}

export async function searchMemories(query: string, limit: number = 10, project?: string) {
  requireEmbedConfig();
  const vector = await embed(query);
  const capped = Math.min(Math.max(1, limit), MAX_SEARCH_LIMIT);
  const r = await qdrant().query(getConfig("COLLECTION"), { query: vector, limit: capped, with_payload: true, filter: projectFilter(project) });
  return JSON.stringify(r.points.map((p) => ({ ...toRecord(p), score: p.score })), null, 2);
}

export async function listMemories(limit: number = 100, offset?: string, project?: string) {
  const capped = Math.min(Math.max(1, limit), MAX_LIST_LIMIT);
  const r = await qdrant().scroll(getConfig("COLLECTION"), { limit: capped, offset, with_payload: true, filter: projectFilter(project) });
  return JSON.stringify({ memories: r.points.map((p) => toRecord(p)), next_offset: r.next_page_offset }, null, 2);
}

export async function getMemory(memory_id: string) {
  const r = await qdrant().retrieve(getConfig("COLLECTION"), { ids: [memory_id], with_payload: true });
  if (!r.length) throw new Error(`Memory not found: ${memory_id}`);
  return JSON.stringify(toRecord(r[0]), null, 2);
}

export async function updateMemory(memory_id: string, text: string, opts: UpdateOptions = {}) {
  if (text.length > MAX_INPUT) throw new Error(`Input too long (${text.length} chars, max ${MAX_INPUT})`);
  validateMetadata(opts);
  requireEmbedConfig();
  const existing = await qdrant().retrieve(getConfig("COLLECTION"), { ids: [memory_id], with_payload: true });
  if (!existing.length) throw new Error(`Memory not found: ${memory_id}`);
  const vector = await embed(text);
  const oldPayload = existing[0].payload as Record<string, unknown>;
  const payload: Record<string, unknown> = {
    text,
    created_at: typeof oldPayload.created_at === "string" ? oldPayload.created_at : nowIso(),
    updated_at: nowIso(),
  };
  if (oldPayload.project !== undefined) payload.project = oldPayload.project;
  if (opts.source !== undefined) payload.source = opts.source;
  else if (typeof oldPayload.source === "string") payload.source = oldPayload.source;
  if (opts.importance !== undefined) payload.importance = opts.importance;
  else if (oldPayload.importance !== undefined) payload.importance = oldPayload.importance;
  if (opts.expires_at !== undefined) payload.expires_at = opts.expires_at;
  else if (typeof oldPayload.expires_at === "string") payload.expires_at = oldPayload.expires_at;
  await qdrant().upsert(getConfig("COLLECTION"), { points: [{ id: memory_id, vector, payload }], wait: true });
  return JSON.stringify({ updated: memory_id });
}

export async function deleteMemories(ids: string[]) {
  await qdrant().delete(getConfig("COLLECTION"), { points: ids, wait: true });
  return JSON.stringify({ deleted: ids.length });
}

export async function deleteAllMemories(project?: string) {
  const filter = project ? { must: [{ key: "project", match: { value: project } }] } : {};
  const countResp = await qdrant().count(getConfig("COLLECTION"), { filter });
  await qdrant().delete(getConfig("COLLECTION"), { filter, wait: true });
  return JSON.stringify({ deleted: countResp.count ?? 0 });
}

export async function getStats() {
  const colName = getConfig("COLLECTION");
  const r = await qdrant().getCollection(colName);
  const pointsCount = r.points_count ?? 0;
  const now = Date.now();
  const dayMs = 86_400_000;

  let oldest: string | undefined;
  let newest: string | undefined;
  let ageSum = 0;
  let ageCount = 0;
  const byProject: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  let expired = 0;
  let expiringSoon = 0;
  let textBytes = 0;

  let offset: string | number | Record<string, unknown> | null | undefined;
  do {
    const page = await qdrant().scroll(colName, { limit: 1000, offset, with_payload: true });
    for (const p of page.points) {
      const payload = p.payload as Record<string, unknown> | undefined;
      const created = typeof payload?.created_at === "string" ? Date.parse(payload.created_at) : NaN;
      if (!isNaN(created)) {
        if (!oldest || created < Date.parse(oldest)) oldest = payload!.created_at as string;
        if (!newest || created > Date.parse(newest)) newest = payload!.created_at as string;
        ageSum += Math.max(0, now - created);
        ageCount++;
      }
      const project = payload?.project;
      if (typeof project === "string" && project) byProject[project] = (byProject[project] ?? 0) + 1;
      const source = payload?.source;
      if (typeof source === "string" && source) bySource[source] = (bySource[source] ?? 0) + 1;
      const expires = typeof payload?.expires_at === "string" ? Date.parse(payload.expires_at) : NaN;
      if (!isNaN(expires)) {
        if (expires <= now) expired++;
        else if (expires - now <= 7 * dayMs) expiringSoon++;
      }
      textBytes += Buffer.byteLength(String(payload?.text ?? ""), "utf-8");
    }
    offset = page.next_page_offset;
  } while (offset !== null && offset !== undefined);

  const stats: Record<string, unknown> = {
    vectors_count: pointsCount,
    collection: colName,
    by_project: byProject,
    by_source: bySource,
    expired,
    expiring_soon_7d: expiringSoon,
    oldest_created_at: oldest ?? null,
    newest_created_at: newest ?? null,
  };
  if (ageCount > 0) stats.avg_age_days = Math.round((ageSum / ageCount / dayMs) * 10) / 10;
  else stats.avg_age_days = null;
  const vectorBytes = (pointsCount * (vectorSize(r) ?? 0) * 4) || 0;
  stats.size_bytes = textBytes + vectorBytes;
  return JSON.stringify(stats, null, 2);
}

export async function verifyCollection(): Promise<{ exists: boolean; size?: number; configured: number; ok: boolean; message: string }> {
  const colName = getConfig("COLLECTION");
  const cfgSize = Number(getConfig("VECTOR_SIZE")) || 768;
  try {
    const cols = await qdrant().getCollections();
    const existing = cols.collections.find((c) => c.name === colName);
    if (!existing) {
      return { exists: false, configured: cfgSize, ok: true, message: `collection "${colName}" will be created on first start` };
    }
    const info = await qdrant().getCollection(colName);
    const actual = vectorSize(info);
    if (actual && actual !== cfgSize) {
      return { exists: true, size: actual, configured: cfgSize, ok: false, message: `collection "${colName}" has vector size ${actual}, but config specifies ${cfgSize}` };
    }
    return { exists: true, size: actual, configured: cfgSize, ok: true, message: `collection "${colName}" ready (vector size ${actual})` };
  } catch (e) {
    return { exists: false, configured: cfgSize, ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function healthCheck(): Promise<string> {
  try {
    await qdrant().getCollections();
    return JSON.stringify({ status: "ok", qdrant: "connected" });
  } catch {
    return JSON.stringify({ status: "degraded", qdrant: "unreachable" });
  }
}
