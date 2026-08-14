import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { addMemories, searchMemories, listMemories, getMemory, updateMemory, deleteMemories, deleteAllMemories, getStats, healthCheck } from "./memory.js";
import { getAllConfig, mask, setConfig, persistConfig } from "./config.js";

interface ToolArgs {
  text?: string;
  query?: string;
  limit?: number;
  offset?: string;
  memory_id?: string;
  ids?: string[];
  key?: string;
  value?: string;
  project?: string;
  source?: string;
  importance?: number;
  expires_at?: string;
  dedup?: boolean;
  threshold?: number;
  persist?: boolean;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function createMcpServer(version: string): Server {
  const mcpServer = new Server({ name: "memoryhub", version }, { capabilities: { tools: {} } });

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "add_memories", description: "Store text (LLM extracts facts, embeds, stores). Deduplicates semantically similar memories by default.", inputSchema: { type: "object", properties: { text: { type: "string" }, project: { type: "string" }, source: { type: "string" }, importance: { type: "number" }, expires_at: { type: "string" }, dedup: { type: "boolean" }, threshold: { type: "number" } }, required: ["text"] } },
      { name: "search_memory", description: "Semantic search across stored memories.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" }, project: { type: "string" } }, required: ["query"] } },
      { name: "list_memories", description: "List stored memories with pagination.", inputSchema: { type: "object", properties: { limit: { type: "number" }, offset: { type: "string" }, project: { type: "string" } } } },
      { name: "get_memory", description: "Get a single memory by ID.", inputSchema: { type: "object", properties: { memory_id: { type: "string" } }, required: ["memory_id"] } },
      { name: "update_memory", description: "Update a memory's text (re-embeds).", inputSchema: { type: "object", properties: { memory_id: { type: "string" }, text: { type: "string" }, source: { type: "string" }, importance: { type: "number" }, expires_at: { type: "string" } }, required: ["memory_id", "text"] } },
      { name: "delete_memories", description: "Delete specific memories by IDs.", inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] } },
      { name: "delete_all_memories", description: "Delete ALL memories (or filter by project).", inputSchema: { type: "object", properties: { project: { type: "string" } } } },
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
          result = await addMemories(a.text, a.project, {
            source: a.source,
            importance: a.importance,
            expires_at: a.expires_at,
            dedup: a.dedup,
            threshold: a.threshold,
          });
          break;
        }
        case "search_memory": {
          assert(typeof a.query === "string" && a.query, "query is required (string)");
          if (a.limit !== undefined) assert(typeof a.limit === "number" && a.limit > 0, "limit must be a positive number");
          if (a.project !== undefined) assert(typeof a.project === "string" && a.project, "project must be a non-empty string");
          result = await searchMemories(a.query, a.limit ?? 10, a.project);
          break;
        }
        case "list_memories": {
          if (a.limit !== undefined) assert(typeof a.limit === "number" && a.limit > 0, "limit must be a positive number");
          if (a.offset !== undefined) assert(typeof a.offset === "string", "offset must be a string");
          if (a.project !== undefined) assert(typeof a.project === "string" && a.project, "project must be a non-empty string");
          result = await listMemories(a.limit ?? 100, a.offset, a.project);
          break;
        }
        case "get_memory": { assert(typeof a.memory_id === "string" && a.memory_id, "memory_id is required (string)"); result = await getMemory(a.memory_id); break; }
        case "update_memory": {
          assert(typeof a.memory_id === "string" && a.memory_id, "memory_id is required (string)");
          assert(typeof a.text === "string" && a.text, "text is required (string)");
          result = await updateMemory(a.memory_id, a.text, { source: a.source, importance: a.importance, expires_at: a.expires_at });
          break;
        }
        case "delete_memories": {
          assert(Array.isArray(a.ids) && a.ids.length > 0, "ids must be a non-empty array of strings");
          assert(a.ids.every((id: unknown) => typeof id === "string"), "each id must be a string");
          result = await deleteMemories(a.ids);
          break;
        }
        case "delete_all_memories": {
          if (a.project !== undefined) assert(typeof a.project === "string" && a.project, "project must be a non-empty string");
          result = await deleteAllMemories(a.project);
          break;
        }
        case "memory_stats": { result = await getStats(); break; }
        case "get_config": { result = JSON.stringify(getAllConfig(), null, 2); break; }
        case "update_config": {
          assert(typeof a.key === "string" && a.key, "key is required (string)");
          assert(typeof a.value === "string", "value is required (string)");
          if (a.persist === true) {
            const path = persistConfig(a.key, a.value);
            const value = a.key === "LLM_KEY" || a.key === "EMBED_KEY" ? mask(a.value) : a.value;
            result = JSON.stringify({ updated: a.key, value, persisted: true, path });
          } else {
            setConfig(a.key, a.value);
            const value = a.key === "LLM_KEY" || a.key === "EMBED_KEY" ? mask(a.value) : a.value;
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
      const code = isValidation ? "VALIDATION_ERROR" : isConfig ? "CONFIG_ERROR" : "INTERNAL_ERROR";
      return { content: [{ type: "text", text: JSON.stringify({ error: message, code }) }], isError: true };
    }
  });

  return mcpServer;
}
