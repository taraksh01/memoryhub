import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ensureCollection, addMemories, searchMemories, listMemories, getMemory, updateMemory, deleteMemories, deleteAllMemories, getStats } from "./memory.js";

interface ToolArgs {
  text?: string;
  query?: string;
  limit?: number;
  memory_id?: string;
  ids?: string[];
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
