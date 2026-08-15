import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { addMemories, searchMemories, listMemories, getMemory, getMemories, updateMemory, deleteMemories, deleteAllMemories, batchAddMemories, exportMemories, importMemories, reviewStale, getStats, healthCheck } from "./memory.js";
import { getAllConfig, getConfig, mask, setConfig, persistConfig } from "./config.js";

interface ToolArgs {
  text?: string;
  query?: string;
  limit?: number;
  offset?: string;
  memory_id?: string;
  ids?: string[];
  items?: unknown[];
  data?: string;
  key?: string;
  value?: string;
  project?: string;
  source?: string;
  exact?: boolean;
  min_score?: number;
  importance?: number;
  expires_at?: string;
  dedup?: boolean;
  threshold?: number;
  persist?: boolean;
  days?: number;
  older_than_days?: number;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const MAX_IDS = 1000;
const MAX_ID_LEN = 256;

function assertValidId(id: string): void {
  assert(id.trim().length > 0, "invalid memory id: must be a non-empty string");
  assert(id.length <= MAX_ID_LEN, `memory id too long (${id.length}, max ${MAX_ID_LEN})`);
}

function assertIdArray(ids: unknown): asserts ids is string[] {
  assert(Array.isArray(ids) && ids.length > 0, "ids must be a non-empty array of strings");
  assert(ids.every((id: unknown) => typeof id === "string"), "each id must be a string");
  assert(ids.length <= MAX_IDS, `too many ids (${ids.length}, max ${MAX_IDS})`);
  ids.forEach((id: string) => assertValidId(id));
}

export function createMcpServer(version: string): Server {
  const mcpServer = new Server({ name: "memoryhub", version }, { capabilities: { tools: {} } });

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "add_memories", description: "Store text (LLM extracts facts, embeds, stores). Deduplicates semantically similar memories by default.", inputSchema: { type: "object", properties: { text: { type: "string" }, project: { type: "string" }, source: { type: "string" }, importance: { type: "number" }, expires_at: { type: "string" }, dedup: { type: "boolean" }, threshold: { type: "number" } }, required: ["text"] } },
      { name: "batch_add_memories", description: "Add multiple texts in one call. Each item follows add_memories semantics; results are reported per item and item-level failures do not abort the batch.", inputSchema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { text: { type: "string" }, project: { type: "string" }, source: { type: "string" }, importance: { type: "number" }, expires_at: { type: "string" }, dedup: { type: "boolean" }, threshold: { type: "number" } }, required: ["text"] } } }, required: ["items"] } },
      { name: "search_memory", description: "Semantic search across stored memories. Set exact=true to match the query text verbatim instead of by similarity; filter by project and/or source; min_score drops hits below a similarity threshold.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" }, project: { type: "string" }, source: { type: "string" }, exact: { type: "boolean" }, min_score: { type: "number" } }, required: ["query"] } },
      { name: "list_memories", description: "List stored memories with pagination; filter by project and/or source.", inputSchema: { type: "object", properties: { limit: { type: "number" }, offset: { type: "string" }, project: { type: "string" }, source: { type: "string" } } } },
      { name: "get_memory", description: "Get a single memory by ID.", inputSchema: { type: "object", properties: { memory_id: { type: "string" } }, required: ["memory_id"] } },
      { name: "get_memories", description: "Get multiple memories by IDs.", inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] } },
      { name: "update_memory", description: "Update a memory's text (re-embeds).", inputSchema: { type: "object", properties: { memory_id: { type: "string" }, text: { type: "string" }, source: { type: "string" }, importance: { type: "number" }, expires_at: { type: "string" } }, required: ["memory_id", "text"] } },
      { name: "delete_memories", description: "Delete specific memories by IDs.", inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] } },
      { name: "delete_all_memories", description: "Delete ALL memories (or filter by project).", inputSchema: { type: "object", properties: { project: { type: "string" } } } },
      { name: "export_memories", description: "Export all memories (optionally filtered by project/source) as JSON for backup or migration.", inputSchema: { type: "object", properties: { project: { type: "string" }, source: { type: "string" } } } },
      { name: "import_memories", description: "Import memories from export_memories JSON (array or {memories: [...]}). Texts are re-embedded on import; original IDs and metadata are preserved.", inputSchema: { type: "object", properties: { data: { type: "string" } }, required: ["data"] } },
      { name: "review_stale", description: "Report-only audit of stale memories: expired, expiring soon, or older than N days. Never modifies data.", inputSchema: { type: "object", properties: { project: { type: "string" }, source: { type: "string" }, days: { type: "number" }, older_than_days: { type: "number" }, limit: { type: "number" } } } },
      { name: "memory_stats", description: "Get collection statistics (totals, per project/source, expiry, age).", inputSchema: { type: "object", properties: {} } },
      { name: "get_config", description: "Show current runtime configuration.", inputSchema: { type: "object", properties: {} } },
      { name: "update_config", description: "Update a config value at runtime. Set persist=true to write it to the config file (survives restart).", inputSchema: { type: "object", properties: { key: { type: "string" }, value: { type: "string" }, persist: { type: "boolean" } }, required: ["key", "value"] } },
      { name: "health_check", description: "Check connectivity to Qdrant.", inputSchema: { type: "object", properties: {} } },
    ],
  }));

  mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const a = args as ToolArgs;
    try {
      let result: string;
      switch (name) {
        case "add_memories": {
          assert(typeof a.text === "string" && a.text, "text is required (string)");
          if (a.project !== undefined) assert(typeof a.project === "string" && a.project, "project must be a non-empty string");
          if (a.dedup !== undefined) assert(typeof a.dedup === "boolean", "dedup must be a boolean");
          if (a.threshold !== undefined) assert(typeof a.threshold === "number" && a.threshold > 0 && a.threshold < 1, "threshold must be a number between 0 and 1");
          result = await addMemories(a.text, a.project, {
            source: a.source,
            importance: a.importance,
            expires_at: a.expires_at,
            dedup: a.dedup,
            threshold: a.threshold,
          });
          break;
        }
        case "batch_add_memories": {
          assert(Array.isArray(a.items) && a.items.length > 0, "items must be a non-empty array");
          assert(a.items.every((it: unknown) => { const t = (it as Record<string, unknown>)?.text; return typeof t === "string" && t.trim() !== ""; }), "each item's text must be a non-empty string");
          result = await batchAddMemories(a.items as { text: string; project?: string; source?: string; importance?: number; expires_at?: string; dedup?: boolean; threshold?: number }[]);
          break;
        }
        case "search_memory": {
          assert(typeof a.query === "string" && a.query, "query is required (string)");
          if (a.limit !== undefined) assert(typeof a.limit === "number" && a.limit > 0, "limit must be a positive number");
          if (a.project !== undefined) assert(typeof a.project === "string" && a.project, "project must be a non-empty string");
          if (a.source !== undefined) assert(typeof a.source === "string" && a.source, "source must be a non-empty string");
          if (a.exact !== undefined) assert(typeof a.exact === "boolean", "exact must be a boolean");
          if (a.min_score !== undefined) assert(typeof a.min_score === "number" && a.min_score > 0 && a.min_score <= 1, "min_score must be a number between 0 and 1");
          assert(!(a.exact === true && a.min_score !== undefined), "when exact=true, min_score must be omitted");
          result = await searchMemories(a.query, a.limit ?? 10, a.project, { source: a.source, exact: a.exact, min_score: a.min_score });
          break;
        }
        case "list_memories": {
          if (a.limit !== undefined) assert(typeof a.limit === "number" && a.limit > 0, "limit must be a positive number");
          if (a.offset !== undefined) assert(typeof a.offset === "string", "offset must be a string");
          if (a.project !== undefined) assert(typeof a.project === "string" && a.project, "project must be a non-empty string");
          if (a.source !== undefined) assert(typeof a.source === "string" && a.source, "source must be a non-empty string");
          result = await listMemories(a.limit ?? 100, a.offset, a.project, a.source);
          break;
        }
        case "get_memory": {
          assert(typeof a.memory_id === "string" && a.memory_id, "memory_id is required (string)");
          assertValidId(a.memory_id);
          result = await getMemory(a.memory_id);
          break;
        }
        case "get_memories": {
          assertIdArray(a.ids);
          result = await getMemories(a.ids);
          break;
        }
        case "update_memory": {
          assert(typeof a.memory_id === "string" && a.memory_id, "memory_id is required (string)");
          assertValidId(a.memory_id);
          assert(typeof a.text === "string" && a.text, "text is required (string)");
          result = await updateMemory(a.memory_id, a.text, { source: a.source, importance: a.importance, expires_at: a.expires_at });
          break;
        }
        case "delete_memories": {
          assertIdArray(a.ids);
          result = await deleteMemories(a.ids);
          break;
        }
        case "delete_all_memories": {
          if (a.project !== undefined) assert(typeof a.project === "string" && a.project, "project must be a non-empty string");
          result = await deleteAllMemories(a.project);
          break;
        }
        case "export_memories": {
          if (a.project !== undefined) assert(typeof a.project === "string" && a.project, "project must be a non-empty string");
          if (a.source !== undefined) assert(typeof a.source === "string" && a.source, "source must be a non-empty string");
          result = await exportMemories(a.project, a.source);
          break;
        }
        case "import_memories": {
          assert(typeof a.data === "string" && a.data, "data is required (string)");
          result = await importMemories(a.data);
          break;
        }
        case "review_stale": {
          if (a.project !== undefined) assert(typeof a.project === "string" && a.project, "project must be a non-empty string");
          if (a.source !== undefined) assert(typeof a.source === "string" && a.source, "source must be a non-empty string");
          if (a.days !== undefined) assert(typeof a.days === "number" && a.days > 0, "days must be a positive number");
          if (a.older_than_days !== undefined) assert(typeof a.older_than_days === "number" && a.older_than_days > 0, "older_than_days must be a positive number");
          if (a.limit !== undefined) assert(typeof a.limit === "number" && a.limit > 0, "limit must be a positive number");
          result = await reviewStale({ project: a.project, source: a.source, days: a.days, older_than_days: a.older_than_days, limit: a.limit });
          break;
        }
        case "memory_stats": { result = await getStats(); break; }
        case "get_config": { result = JSON.stringify(getAllConfig(), null, 2); break; }
        case "update_config": {
          assert(typeof a.key === "string" && a.key, "key is required (string)");
          assert(typeof a.value === "string", "value is required (string)");
          if (a.persist === true) {
            const path = persistConfig(a.key, a.value);
            const effective = getConfig(a.key);
            const value = a.key === "LLM_KEY" || a.key === "EMBED_KEY" || a.key === "API_TOKEN" ? mask(effective) : effective;
            result = JSON.stringify({ updated: a.key, value, persisted: true, path });
          } else {
            setConfig(a.key, a.value);
            const effective = getConfig(a.key);
            const value = a.key === "LLM_KEY" || a.key === "EMBED_KEY" || a.key === "API_TOKEN" ? (effective === "" ? "" : mask(effective)) : effective;
            result = JSON.stringify({ updated: a.key, value, persisted: false });
          }
          break;
        }
        case "health_check": { result = await healthCheck(); break; }
        default: throw new Error(`Unknown tool: ${name}`);
      }
      return { content: [{ type: "text", text: result }] };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      const isValidation = message.includes("is required") || message.includes("must be");
      const isConfig = message.includes("config") || message.includes("Config");
      const isNotFound = message.includes("not found");
      const code = isValidation ? "VALIDATION_ERROR" : isConfig ? "CONFIG_ERROR" : isNotFound ? "NOT_FOUND" : "INTERNAL_ERROR";
      return { content: [{ type: "text", text: JSON.stringify({ error: message, code }) }], isError: true };
    }
  });

  return mcpServer;
}
