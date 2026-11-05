import { QdrantClient, QdrantClientResourceExhaustedError } from "@qdrant/js-client-rest";
import { createHash, randomUUID } from "node:crypto";
import { getConfig, requireEmbedConfig } from "./config.js";

let _qdrant: QdrantClient | null = null;
let _qdrantUrl = "";

async function qdrantRetry<T>(call: () => Promise<T>): Promise<T> {
  const delay = Number(getConfig("RETRY_DELAY_MS")) || 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      if (attempt >= 3 || !(e instanceof QdrantClientResourceExhaustedError)) throw e;
      await new Promise((r) => setTimeout(r, delay * attempt));
    }
  }
}

function qdrant(): QdrantClient {
  const url = getConfig("QDRANT_URL");
  if (!_qdrant || url !== _qdrantUrl) {
    const client = new QdrantClient({ url, timeout: 30_000 });
    _qdrant = new Proxy(client, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => qdrantRetry(() => v.apply(target, args) as Promise<unknown>);
      },
    }) as QdrantClient;
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

function jsonObjectConfig(key: string): Record<string, string> {
  const raw = getConfig(key);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    console.error(`memoryhub: ignoring ${key} — must be a JSON object`);
  } catch {
    console.error(`memoryhub: ignoring ${key} — invalid JSON`);
  }
  return {};
}

// Reasoning-era models (OpenAI gpt-5*, o-series) reject `max_tokens` and any
// non-default `temperature`, so zero-config defaults adapt to the model name.
function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o[1-9])/i.test(model);
}

function tokenLimitParams(model: string): Record<string, number> {
  const forced = getConfig("LLM_MAX_TOKENS_PARAM");
  if (forced === "none") return {};
  const name = !forced || forced === "auto" ? (isReasoningModel(model) ? "max_completion_tokens" : "max_tokens") : forced;
  const value = Number(getConfig("LLM_MAX_TOKENS"));
  if (!Number.isFinite(value) || value <= 0) return {};
  return { [name]: value };
}

function temperatureParams(model: string): Record<string, number> {
  const cfg = getConfig("LLM_TEMPERATURE");
  if (cfg === "none" || (cfg === "auto" && isReasoningModel(model))) return {};
  const value = cfg === "auto" ? 0.1 : Number(cfg);
  if (!Number.isFinite(value)) return {};
  return { temperature: value };
}

export async function llm(messages: ChatMessage[]): Promise<string> {
  const base = getConfig("LLM_BASE");
  const key = getConfig("LLM_KEY");
  return withRetry(async () => {
    const model = getConfig("LLM_MODEL");
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...jsonObjectConfig("LLM_EXTRA_HEADERS") };
    const body = {
      model,
      messages,
      ...tokenLimitParams(model),
      ...temperatureParams(model),
      ...jsonObjectConfig("LLM_EXTRA_BODY"),
    };
    const r = await fetchWithTimeout(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = await r.text();
      const err = new Error(`LLM ${r.status}: ${text.slice(0, 300)}`) as ErrorWithStatus;
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
  return withRetry(async () => {
    const model = getConfig("EMBED_MODEL");
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...jsonObjectConfig("EMBED_EXTRA_HEADERS") };
    const body = { model, input: text, ...jsonObjectConfig("EMBED_EXTRA_BODY") };
    const r = await fetchWithTimeout(`${base}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const errText = await r.text();
      const err = new Error(`Embed ${r.status}: ${errText.slice(0, 300)}`) as ErrorWithStatus;
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
      if (!Array.isArray(parsed)) {
        lastError = `non-array: ${cleaned.slice(0, 200)}`;
        continue;
      }
      const facts = parsed.filter((f): f is string => typeof f === "string").map(f => f.trim()).filter(f => f.length > 0);
      if (!facts.length) {
        lastError = "empty facts: " + cleaned.slice(0, 200);
        continue;
      }
      return facts;
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

async function ensurePayloadIndexes(colName: string): Promise<void> {
  const defs = [
    { field_name: "created_at", field_schema: "integer" as const },
    { field_name: "project", field_schema: "keyword" as const },
    { field_name: "source", field_schema: "keyword" as const },
  ];
  for (const d of defs) {
    try {
      await qdrant().createPayloadIndex(colName, d);
    } catch {
      // index already exists or collection not ready — best effort
    }
  }
}

export async function ensureCollection() {
  const cols = await qdrant().getCollections();
  const colName = getConfig("COLLECTION");
  const cfgSize = Number(getConfig("VECTOR_SIZE")) || 768;
  if (!Number.isInteger(cfgSize) || cfgSize <= 0) {
    throw new Error(`VECTOR_SIZE must be a positive integer, got "${getConfig("VECTOR_SIZE")}"`);
  }
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
  await ensurePayloadIndexes(colName);
}

const MAX_INPUT = 50_000;
const EMBED_CONCURRENCY = 5;
const MAX_SEARCH_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;
const MAX_STATS_SCAN = 50_000;

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
  links?: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function validateMetadata(opts: { source?: string; importance?: number; expires_at?: string; threshold?: number; dedup?: boolean }): void {
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
  if (opts.threshold !== undefined) {
    if (typeof opts.threshold !== "number" || isNaN(opts.threshold) || opts.threshold <= 0 || opts.threshold >= 1) {
      throw new Error("threshold must be a number between 0 and 1");
    }
  }
  if (opts.dedup !== undefined && typeof opts.dedup !== "boolean") {
    throw new Error("dedup must be a boolean");
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
  if (Array.isArray(payload.links)) rec.links = payload.links.filter((l): l is string => typeof l === "string");
  return rec;
}

function payloadFilter(project?: string, source?: string): { must: Record<string, unknown>[] } | undefined {
  const must: Record<string, unknown>[] = [];
  if (project) must.push({ key: "project", match: { value: project } });
  if (source) must.push({ key: "source", match: { value: source } });
  return must.length ? { must } : undefined;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function legacyIdToUuid(id: string): string {
  const h = createHash("sha256").update(id).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function qdrantId(id: string): string | number {
  if (/^\d+$/.test(id)) {
    const n = Number(id);
    if (Number.isSafeInteger(n) && String(n) === id) return n;
    return legacyIdToUuid(id);
  }
  if (UUID_RE.test(id)) return id;
  return legacyIdToUuid(id);
}

export function decideAction(score: number, threshold: number, skipThreshold: number): "merged" | "skipped" | "inserted" {
  if (score >= skipThreshold) return "skipped";
  if (score >= threshold) return "merged";
  return "inserted";
}

export function mergeTexts(oldText: string, newText: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  const sentences = (s: string): string[] => s.trim().split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 0);
  for (const part of [...sentences(oldText), ...sentences(newText)]) {
    const key = part.toLowerCase().replace(/[.!?]+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(part);
  }
  return parts.join(" ");
}

async function findDuplicate(fact: string, vector: number[], project?: string, source?: string): Promise<{ id: string; text: string; score: number } | null> {
  const r = await qdrant().query(getConfig("COLLECTION"), { query: vector, limit: 1, with_payload: true, filter: payloadFilter(project, source) });
  const top = r.points[0];
  if (!top || typeof top.score !== "number") return null;
  return { id: String(top.id), text: String(top.payload?.text ?? ""), score: top.score };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

interface ProjectLock {
  promise: Promise<void>;
  settled: boolean;
}

const projectLocks = new Map<string, ProjectLock>();
const MAX_PROJECT_LOCKS = 1000;

async function withProjectLock(project: string, fn: () => Promise<void>): Promise<void> {
  const prev = projectLocks.get(project)?.promise ?? Promise.resolve();
  const entry: ProjectLock = {
    promise: prev.then(fn, fn).finally(() => { entry.settled = true; }),
    settled: false,
  };
  projectLocks.set(project, entry);
  try {
    await entry.promise;
  } finally {
    if (projectLocks.size > MAX_PROJECT_LOCKS) {
      for (const [k, e] of projectLocks) {
        if (projectLocks.size <= MAX_PROJECT_LOCKS) break;
        if (e.settled) projectLocks.delete(k);
      }
    }
  }
}

export async function addMemoriesRaw(text: string, project?: string, opts: AddOptions = {}): Promise<{ added: number; merged: number; skipped: number; memories: AddOutcome[] }> {
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
    const run = async () => {
      if (dedupEnabled) {
        const dup = await findDuplicate(fact, vector, project, opts.source);
        if (dup) {
          const action = decideAction(dup.score, threshold, skipThreshold);
          if (action === "skipped") {
            outcomes.push({ id: dup.id, text: fact, action });
            return;
          }
          if (action === "merged") {
            const mergedText = mergeTexts(dup.text, fact);
            const mergedVector = await embed(mergedText);
            const existing = await qdrant().retrieve(getConfig("COLLECTION"), { ids: [qdrantId(dup.id)], with_payload: true });
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
            await qdrant().upsert(getConfig("COLLECTION"), { points: [{ id: qdrantId(dup.id), vector: mergedVector, payload }], wait: true });
            outcomes.push({ id: dup.id, text: mergedText, action: "merged" });
            return;
          }
        }
      }
      const payload: Record<string, unknown> = { ...basePayload(opts, now), text: fact };
      if (project) payload.project = project;
      const id = randomUUID();
      await qdrant().upsert(getConfig("COLLECTION"), { points: [{ id, vector, payload }], wait: true });
      outcomes.push({ id, text: fact, action: "inserted" });
    };
    if (dedupEnabled) await withProjectLock(project ?? "", run);
    else await run();
  });

  const added = outcomes.filter((o) => o.action === "inserted").length;
  const merged = outcomes.filter((o) => o.action === "merged").length;
  const skipped = outcomes.filter((o) => o.action === "skipped").length;
  return { added, merged, skipped, memories: outcomes };
}

export async function addMemories(text: string, project?: string, opts: AddOptions = {}) {
  return JSON.stringify(await addMemoriesRaw(text, project, opts), null, 2);
}

export interface BatchItem {
  text: string;
  project?: string;
  source?: string;
  importance?: number;
  expires_at?: string;
  dedup?: boolean;
  threshold?: number;
}

const BATCH_CONCURRENCY = 5;
const MAX_BATCH_ITEMS = 100;

export async function batchAddMemories(items: BatchItem[]) {
  if (!items.length) throw new Error("items must be a non-empty array");
  if (items.length > MAX_BATCH_ITEMS) throw new Error(`Too many items (${items.length}, max ${MAX_BATCH_ITEMS})`);
  const results: (Record<string, unknown> | undefined)[] = new Array(items.length);
  await mapLimit(items, BATCH_CONCURRENCY, async (item, index) => {
    try {
      const r = await addMemoriesRaw(item.text, item.project, {
        source: item.source,
        importance: item.importance,
        expires_at: item.expires_at,
        dedup: item.dedup,
        threshold: item.threshold,
      });
      results[index] = { index, ...r };
    } catch (e) {
      results[index] = { index, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return JSON.stringify({ processed: items.length, items: results }, null, 2);
}

export async function exportMemories(project?: string, source?: string) {
  const filter = payloadFilter(project, source);
  const records: MemoryRecord[] = [];
  let truncated = false;
  let offset: string | number | Record<string, unknown> | null | undefined;
  do {
    const page = await qdrant().scroll(getConfig("COLLECTION"), { limit: MAX_LIST_LIMIT, offset, with_payload: true, filter });
    for (const p of page.points) {
      if (records.length >= MAX_STATS_SCAN) { truncated = true; break; }
      records.push(toRecord(p));
    }
    if (truncated) break;
    offset = page.next_page_offset;
  } while (offset !== null && offset !== undefined);
  const out: Record<string, unknown> = { exported_at: nowIso(), count: records.length, memories: records };
  if (truncated) out.truncated = true;
  return JSON.stringify(out, null, 2);
}

const IMPORT_CONCURRENCY = 5;
const MAX_IMPORT_ITEMS = 10_000;

function validateImportRecord(r: unknown, index: number): MemoryRecord {
  if (typeof r !== "object" || r === null) throw new Error(`item ${index}: must be an object`);
  const rec = r as Record<string, unknown>;
  if (typeof rec.text !== "string" || !rec.text.trim()) throw new Error(`item ${index}: text must be a non-empty string`);
  if (rec.id !== undefined && (typeof rec.id !== "string" || !rec.id.trim())) throw new Error(`item ${index}: id must be a non-empty string`);
  if (rec.project !== undefined && (typeof rec.project !== "string" || !rec.project.trim())) throw new Error(`item ${index}: project must be a non-empty string`);
  if (rec.source !== undefined && (typeof rec.source !== "string" || !rec.source.trim())) throw new Error(`item ${index}: source must be a non-empty string`);
  if (rec.importance !== undefined && (typeof rec.importance !== "number" || rec.importance < 0 || rec.importance > 1)) throw new Error(`item ${index}: importance must be a number between 0 and 1`);
  if (rec.links !== undefined && (!Array.isArray(rec.links) || rec.links.some((l) => typeof l !== "string"))) throw new Error(`item ${index}: links must be an array of memory ids`);
  for (const k of ["created_at", "updated_at", "expires_at"] as const) {
    if (rec[k] !== undefined && (typeof rec[k] !== "string" || isNaN(Date.parse(rec[k])))) throw new Error(`item ${index}: ${k} must be a valid ISO date string`);
  }
  return {
    id: typeof rec.id === "string" ? rec.id : randomUUID(),
    text: rec.text,
    ...(typeof rec.project === "string" ? { project: rec.project } : {}),
    ...(typeof rec.source === "string" ? { source: rec.source } : {}),
    ...(typeof rec.importance === "number" ? { importance: rec.importance } : {}),
    ...(typeof rec.created_at === "string" ? { created_at: rec.created_at } : {}),
    ...(typeof rec.updated_at === "string" ? { updated_at: rec.updated_at } : {}),
    ...(typeof rec.expires_at === "string" ? { expires_at: rec.expires_at } : {}),
    ...(Array.isArray(rec.links) ? { links: rec.links as string[] } : {}),
  };
}

export async function importMemories(data: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (e) {
    throw new Error(`data must be valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown>)?.memories;
  if (!Array.isArray(list)) throw new Error("data must be an array of memories or an export envelope {memories: [...]}");
  if (list.length > MAX_IMPORT_ITEMS) throw new Error(`Too many items (${list.length}, max ${MAX_IMPORT_ITEMS})`);
  requireEmbedConfig();
  const now = nowIso();
  let imported = 0;
  const failed: Record<string, unknown>[] = [];
  await mapLimit(list, IMPORT_CONCURRENCY, async (raw, index) => {
    try {
      const rec = validateImportRecord(raw, index);
      const vector = await embed(rec.text);
      const payload: Record<string, unknown> = {
        text: rec.text,
        created_at: rec.created_at ?? now,
        updated_at: rec.updated_at ?? now,
      };
      if (rec.project) payload.project = rec.project;
      if (rec.source) payload.source = rec.source;
      if (rec.importance !== undefined) payload.importance = rec.importance;
      if (rec.expires_at) payload.expires_at = rec.expires_at;
      if (rec.links && rec.links.length) payload.links = rec.links;
      await qdrant().upsert(getConfig("COLLECTION"), { points: [{ id: qdrantId(rec.id), vector, payload }], wait: true });
      imported++;
    } catch (e) {
      failed.push({ index, error: e instanceof Error ? e.message : String(e) });
    }
  });
  return JSON.stringify({ imported, failed }, null, 2);
}

export async function getMemories(ids: string[]) {
  const r = await qdrant().retrieve(getConfig("COLLECTION"), { ids: ids.map(qdrantId), with_payload: true });
  return JSON.stringify({ memories: r.map((p) => toRecord(p)) }, null, 2);
}

export interface SearchOptions {
  source?: string;
  exact?: boolean;
  min_score?: number;
}

export async function searchMemories(query: string, limit: number = 10, project?: string, opts: SearchOptions = {}) {
  const capped = Math.min(Math.max(1, limit), MAX_SEARCH_LIMIT);
  const filter = payloadFilter(project, opts.source);
  if (opts.exact) {
    const must = [...(filter?.must ?? []), { key: "text", match: { value: query } }];
    const r = await qdrant().scroll(getConfig("COLLECTION"), { limit: capped, with_payload: true, filter: { must } });
    return JSON.stringify(r.points.map((p) => toRecord(p)), null, 2);
  }
  requireEmbedConfig();
  const vector = await embed(query);
  const r = await qdrant().query(getConfig("COLLECTION"), {
    query: vector,
    limit: capped,
    with_payload: true,
    filter,
    score_threshold: opts.min_score,
  });
  return JSON.stringify(r.points.map((p) => ({ ...toRecord(p), score: p.score })), null, 2);
}

export async function listMemories(limit: number = 100, offset?: string, project?: string, source?: string) {
  const capped = Math.min(Math.max(1, limit), MAX_LIST_LIMIT);
  const r = await qdrant().scroll(getConfig("COLLECTION"), {
    limit: capped,
    offset,
    with_payload: true,
    filter: payloadFilter(project, source),
  });
  return JSON.stringify({ memories: r.points.map((p) => toRecord(p)), next_offset: r.next_page_offset }, null, 2);
}

export async function getMemory(memory_id: string) {
  const r = await qdrant().retrieve(getConfig("COLLECTION"), { ids: [qdrantId(memory_id)], with_payload: true });
  if (!r.length) throw new Error(`Memory not found: ${memory_id}`);
  return JSON.stringify(toRecord(r[0]), null, 2);
}

export async function updateMemory(memory_id: string, text: string, opts: UpdateOptions = {}) {
  if (text.length > MAX_INPUT) throw new Error(`Input too long (${text.length} chars, max ${MAX_INPUT})`);
  validateMetadata(opts);
  requireEmbedConfig();
  const existing = await qdrant().retrieve(getConfig("COLLECTION"), { ids: [qdrantId(memory_id)], with_payload: true });
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
  await qdrant().upsert(getConfig("COLLECTION"), { points: [{ id: qdrantId(memory_id), vector, payload }], wait: true });
  return JSON.stringify({ updated: memory_id });
}

export async function deleteMemories(ids: string[]) {
  const normalized = ids.map(qdrantId);
  const found = await qdrant().retrieve(getConfig("COLLECTION"), { ids: normalized, with_payload: false });
  await qdrant().delete(getConfig("COLLECTION"), { points: normalized, wait: true });
  return JSON.stringify({ deleted: found.length });
}

export async function deleteAllMemories(project?: string) {
  const filter = project ? { must: [{ key: "project", match: { value: project } }] } : {};
  const countResp = await qdrant().count(getConfig("COLLECTION"), { filter, exact: true });
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
  let scanned = 0;
  let truncated = false;

  let offset: string | number | Record<string, unknown> | null | undefined;
  do {
    const page = await qdrant().scroll(colName, { limit: 1000, offset, with_payload: true });
    for (const p of page.points) {
      if (scanned >= MAX_STATS_SCAN) { truncated = true; break; }
      scanned++;
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
    if (truncated) break;
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
  if (truncated) stats.truncated = true;
  if (ageCount > 0) stats.avg_age_days = Math.round((ageSum / ageCount / dayMs) * 10) / 10;
  else stats.avg_age_days = null;
  const vectorBytes = (pointsCount * (vectorSize(r) ?? 0) * 4) || 0;
  stats.text_bytes = textBytes;
  stats.size_bytes = textBytes + vectorBytes;
  return JSON.stringify(stats, null, 2);
}

export interface ReviewStaleOptions {
  project?: string;
  source?: string;
  days?: number;
  older_than_days?: number;
  limit?: number;
}

export async function reviewStale(opts: ReviewStaleOptions = {}) {
  const days = Math.max(1, opts.days ?? 7);
  const olderThanDays = Math.max(1, opts.older_than_days ?? 90);
  const limit = Math.min(Math.max(1, opts.limit ?? 50), MAX_SEARCH_LIMIT);
  const now = Date.now();
  const dayMs = 86_400_000;
  const filter = payloadFilter(opts.project, opts.source);

  const expired: Record<string, unknown>[] = [];
  const expiringSoon: Record<string, unknown>[] = [];
  const olderThan: Record<string, unknown>[] = [];
  let expiredTotal = 0;
  let expiringTotal = 0;
  let olderTotal = 0;
  let checked = 0;
  let truncated = false;

  let offset: string | number | Record<string, unknown> | null | undefined;
  do {
    const page = await qdrant().scroll(getConfig("COLLECTION"), { limit: MAX_LIST_LIMIT, offset, with_payload: true, filter });
    for (const p of page.points) {
      if (checked >= MAX_STATS_SCAN) { truncated = true; break; }
      checked++;
      const rec = toRecord(p);
      const preview = rec.text.length > 120 ? rec.text.slice(0, 120) + "..." : rec.text;
      const expires = rec.expires_at ? Date.parse(rec.expires_at) : NaN;
      if (!isNaN(expires)) {
        if (expires <= now) {
          expiredTotal++;
          if (expired.length < limit) {
            expired.push({ id: rec.id, text: preview, expires_at: rec.expires_at, days_overdue: Math.floor((now - expires) / dayMs) });
          }
        } else if (expires - now <= days * dayMs) {
          expiringTotal++;
          if (expiringSoon.length < limit) {
            expiringSoon.push({ id: rec.id, text: preview, expires_at: rec.expires_at, days_left: Math.ceil((expires - now) / dayMs) });
          }
        }
      }
      const created = rec.created_at ? Date.parse(rec.created_at) : NaN;
      if (!isNaN(created) && now - created > olderThanDays * dayMs) {
        olderTotal++;
        if (olderThan.length < limit) {
          olderThan.push({ id: rec.id, text: preview, created_at: rec.created_at, age_days: Math.floor((now - created) / dayMs) });
        }
      }
    }
    if (truncated) break;
    offset = page.next_page_offset;
  } while (offset !== null && offset !== undefined);

  return JSON.stringify({
    report_only: true,
    checked,
    ...(truncated ? { truncated: true } : {}),
    buckets: {
      expired: { count: expiredTotal, memories: expired },
      [`expiring_soon_${days}d`]: { count: expiringTotal, memories: expiringSoon },
      [`older_than_${olderThanDays}d`]: { count: olderTotal, memories: olderThan },
    },
    note: truncated
      ? `Report only — no memories were modified. Scan capped at ${MAX_STATS_SCAN} points; counts and lists are partial.`
      : "Report only — no memories were modified. Memories may appear in multiple buckets. Bucket counts are exact; the memories list is capped at the limit.",
  }, null, 2);
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

// --- dashboard support ---

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** A single memory plus its auto (similarity) and manual (explicit) relations. */
export async function relatedMemories(id: string, limit = 6): Promise<string> {
  const col = getConfig("COLLECTION");
  const capped = Math.min(Math.max(1, limit), 25);
  const found = await qdrant().retrieve(col, { ids: [qdrantId(id)], with_payload: true, with_vector: true });
  const point = found[0] as { id: string | number; payload?: Record<string, unknown>; vector?: unknown } | undefined;
  if (!point) throw new Error(`memory not found: ${id}`);
  const record = toRecord(point);
  const vector = Array.isArray(point.vector) ? (point.vector as number[]) : undefined;

  let related: Array<MemoryRecord & { score: number }> = [];
  if (vector) {
    const res = await qdrant().query(col, { query: vector, limit: capped + 1, with_payload: true });
    related = (res.points as Array<{ id: string | number; payload?: Record<string, unknown>; score?: number }>)
      .filter((p) => String(p.id) !== String(point.id))
      .slice(0, capped)
      .map((p) => ({ ...toRecord(p), score: typeof p.score === "number" ? p.score : 0 }));
  }

  const linkIds = record.links ?? [];
  const manual = linkIds.length
    ? (await qdrant().retrieve(col, { ids: linkIds.map(qdrantId), with_payload: true })).map((p) => toRecord(p as { id: string | number; payload?: Record<string, unknown> | null }))
    : [];

  return JSON.stringify({ memory: record, related, manual }, null, 2);
}

export async function linkMemories(id: string, linkIds: string[]): Promise<string> {
  const col = getConfig("COLLECTION");
  const found = await qdrant().retrieve(col, { ids: [qdrantId(id)], with_payload: true });
  if (!found[0]) throw new Error(`memory not found: ${id}`);
  const existing = toRecord(found[0] as { id: string | number; payload?: Record<string, unknown> | null }).links ?? [];
  const merged = Array.from(new Set([...existing, ...linkIds.filter((l) => l && l !== id)]));
  await qdrant().setPayload(col, { points: [qdrantId(id)], payload: { links: merged }, wait: true });
  return JSON.stringify({ id, links: merged }, null, 2);
}

export async function unlinkMemories(id: string, linkIds: string[]): Promise<string> {
  const col = getConfig("COLLECTION");
  const found = await qdrant().retrieve(col, { ids: [qdrantId(id)], with_payload: true });
  if (!found[0]) throw new Error(`memory not found: ${id}`);
  const existing = toRecord(found[0] as { id: string | number; payload?: Record<string, unknown> | null }).links ?? [];
  const remaining = existing.filter((l) => !linkIds.includes(l));
  await qdrant().setPayload(col, { points: [qdrantId(id)], payload: { links: remaining }, wait: true });
  return JSON.stringify({ id, links: remaining }, null, 2);
}

let graphCache: { key: string; at: number; data: string } | null = null;

/**
 * Graph data for the relations view: nodes plus edges that are either manual
 * links or high-similarity neighbours.
 * ponytail: O(n^2) similarity over the scanned nodes; cap `maxNodes` (and cache)
 * until the corpus grows enough to justify Qdrant-side kNN per node.
 */
export async function graphMemories(threshold = 0.55, maxNodes = 300, neighbors = 4): Promise<string> {
  const col = getConfig("COLLECTION");
  const thr = Math.min(Math.max(0, threshold), 1);
  const cap = Math.min(Math.max(10, maxNodes), 2000);
  const key = `${col}:${thr}:${cap}:${neighbors}`;
  if (graphCache && graphCache.key === key && Date.now() - graphCache.at < 60_000) return graphCache.data;

  const page = await qdrant().scroll(col, { limit: cap, with_payload: true, with_vector: true });
  const points = page.points as Array<{ id: string | number; payload?: Record<string, unknown> | null; vector?: unknown }>;
  const nodes = points.map((p) => {
    const r = toRecord(p);
    return { id: r.id, text: r.text, project: r.project ?? null, source: r.source ?? null, importance: r.importance ?? null, links: r.links ?? [] };
  });
  const idx = new Map<string, number>();
  nodes.forEach((n, i) => idx.set(n.id, i));
  const vecs = points.map((p) => (Array.isArray(p.vector) ? (p.vector as number[]) : null));

  const edges = new Map<string, { source: string; target: string; score: number; kind: "similar" | "manual" }>();
  for (const n of nodes) {
    for (const l of n.links) {
      if (!idx.has(l)) continue;
      const [a, b] = n.id < l ? [n.id, l] : [l, n.id];
      edges.set(`${a}|${b}`, { source: a, target: b, score: 1, kind: "manual" });
    }
  }
  for (let i = 0; i < nodes.length; i++) {
    if (!vecs[i]) continue;
    const best: Array<{ j: number; score: number }> = [];
    for (let j = 0; j < nodes.length; j++) {
      if (i === j || !vecs[j]) continue;
      const score = cosine(vecs[i]!, vecs[j]!);
      if (score < thr) continue;
      best.push({ j, score });
    }
    best.sort((x, y) => y.score - x.score);
    for (const { j, score } of best.slice(0, Math.max(1, neighbors))) {
      const [a, b] = nodes[i].id < nodes[j].id ? [nodes[i].id, nodes[j].id] : [nodes[j].id, nodes[i].id];
      const existing = edges.get(`${a}|${b}`);
      if (!existing || (existing.kind === "similar" && score > existing.score)) {
        edges.set(`${a}|${b}`, { source: a, target: b, score, kind: "similar" });
      }
    }
  }

  const data = JSON.stringify({ nodes, edges: [...edges.values()], threshold: thr, capped: nodes.length < cap });
  graphCache = { key, at: Date.now(), data };
  return data;
}

let dupCache: { key: string; at: number; data: string } | null = null;

/**
 * Near-identical memory pairs, for the dashboard's duplicates view.
 * ponytail: O(n^2) over the scanned nodes; cap `maxNodes` until the corpus grows.
 */
export async function duplicatePairs(threshold = 0.98, maxNodes = 500, limit = 50): Promise<string> {
  const col = getConfig("COLLECTION");
  const thr = Math.min(Math.max(0, threshold), 1);
  const cap = Math.min(Math.max(10, maxNodes), 2000);
  const max = Math.min(Math.max(1, limit), 200);
  const key = `${col}:${thr}:${cap}:${max}`;
  if (dupCache && dupCache.key === key && Date.now() - dupCache.at < 30_000) return dupCache.data;

  const page = await qdrant().scroll(col, { limit: cap, with_payload: true, with_vector: true });
  const points = page.points as Array<{ id: string | number; payload?: Record<string, unknown> | null; vector?: unknown }>;
  const vecs = points.map((p) => (Array.isArray(p.vector) ? (p.vector as number[]) : null));
  const pairs: Array<{ a: MemoryRecord; b: MemoryRecord; score: number }> = [];
  for (let i = 0; i < points.length; i++) {
    if (!vecs[i]) continue;
    for (let j = i + 1; j < points.length; j++) {
      if (!vecs[j]) continue;
      const score = cosine(vecs[i]!, vecs[j]!);
      if (score >= thr) pairs.push({ a: toRecord(points[i]), b: toRecord(points[j]), score });
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  const data = JSON.stringify({ pairs: pairs.slice(0, max), scanned: points.length, threshold: thr }, null, 2);
  dupCache = { key, at: Date.now(), data };
  return data;
}
