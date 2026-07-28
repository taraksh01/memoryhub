#!/usr/bin/env node
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ensureCollection, addMemories, searchMemories, listMemories, getMemory, updateMemory, deleteMemories, deleteAllMemories, getStats, healthCheck } from "./memory.js";
import { MEMORYHUB_DIR, getAllConfig, setConfig } from "./config.js";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createServer, IncomingMessage, ServerResponse } from "node:http";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const PID_FILE = join(MEMORYHUB_DIR, "hub.pid");
const PORT = Number(process.env.MEMORYHUB_PORT) || 9876;

interface ToolArgs {
  text?: string;
  query?: string;
  limit?: number;
  offset?: number;
  memory_id?: string;
  ids?: string[];
  key?: string;
  value?: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = parseInt(readFileSync(PID_FILE, "utf-8"), 10);
  return isNaN(pid) ? null : pid;
}

function removePid() {
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
}

const cmd = process.argv[2];

function showHelp() {
  console.log(`memoryhub v${version}

Usage:
  memoryhub              Start MCP server in stdio mode
  memoryhub serve        Start HTTP/SSE server
  memoryhub start        Daemon mode (background)
  memoryhub stop         Stop daemon
  memoryhub status       Check daemon status
  memoryhub --help, -h   Show this help
  memoryhub --version, -v Show version

MCP tools:
  add_memories, search_memory, list_memories, get_memory,
  update_memory, delete_memories, delete_all_memories,
  memory_stats, get_config, update_config, health_check

Docs: https://github.com/taraksh01/memoryhub`);
}

if (cmd === "--help" || cmd === "-h") { showHelp(); process.exit(0); }
if (cmd === "--version" || cmd === "-v") { console.log(version); process.exit(0); }

if (cmd === "start") {
  const { fork } = await import("node:child_process");
  const child = fork(process.argv[1], ["serve"], { detached: true, stdio: "ignore" });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  console.log("memoryhub started (PID: %d)", child.pid);
  process.exit(0);
}

if (cmd === "stop") {
  const pid = readPid();
  if (!pid) { console.log("memoryhub not running"); process.exit(0); }
  try {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (!readPid()) { console.log("memoryhub stopped"); process.exit(0); }
    }
    process.kill(pid, "SIGKILL");
    removePid();
    console.log("memoryhub force killed");
  } catch {
    removePid();
    console.log("memoryhub not running");
  }
  process.exit(0);
}

if (cmd === "status") {
  const pid = readPid();
  if (!pid) { console.log("memoryhub: stopped"); process.exit(0); }
  try {
    process.kill(pid, 0);
    console.log("memoryhub: running (PID %d)", pid);
  } catch { removePid(); console.log("memoryhub: stopped (stale PID)"); }
  process.exit(0);
}

const mcpServer = new Server({ name: "memoryhub", version }, { capabilities: { tools: {} } });

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "add_memories", description: "Store text (LLM extracts facts, embeds, stores).", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "search_memory", description: "Semantic search across stored memories.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] } },
    { name: "list_memories", description: "List stored memories with pagination.", inputSchema: { type: "object", properties: { limit: { type: "number" }, offset: { type: "number" } } } },
    { name: "get_memory", description: "Get a single memory by ID.", inputSchema: { type: "object", properties: { memory_id: { type: "string" } }, required: ["memory_id"] } },
    { name: "update_memory", description: "Update a memory's text (re-embeds).", inputSchema: { type: "object", properties: { memory_id: { type: "string" }, text: { type: "string" } }, required: ["memory_id", "text"] } },
    { name: "delete_memories", description: "Delete specific memories by IDs.", inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] } },
    { name: "delete_all_memories", description: "Delete ALL memories.", inputSchema: { type: "object", properties: {} } },
    { name: "memory_stats", description: "Get collection statistics.", inputSchema: { type: "object", properties: {} } },
    { name: "get_config", description: "Show current runtime configuration.", inputSchema: { type: "object", properties: {} } },
    { name: "update_config", description: "Update a config value at runtime (not persisted).", inputSchema: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"] } },
    { name: "health_check", description: "Check connectivity to Qdrant.", inputSchema: { type: "object", properties: {} } },
  ],
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = args as ToolArgs;
  try {
    let result: string;
    switch (name) {
      case "add_memories": { assert(typeof a.text === "string" && a.text, "text is required"); result = await addMemories(a.text); break; }
      case "search_memory": { assert(typeof a.query === "string" && a.query, "query is required"); result = await searchMemories(a.query, a.limit ?? 10); break; }
      case "list_memories": { result = await listMemories(a.limit ?? 100, a.offset); break; }
      case "get_memory": { assert(typeof a.memory_id === "string" && a.memory_id, "memory_id is required"); result = await getMemory(a.memory_id); break; }
      case "update_memory": { assert(typeof a.memory_id === "string" && a.memory_id, "memory_id is required"); assert(typeof a.text === "string" && a.text, "text is required"); result = await updateMemory(a.memory_id, a.text); break; }
      case "delete_memories": { assert(Array.isArray(a.ids) && a.ids.length > 0, "ids must be a non-empty array"); result = await deleteMemories(a.ids); break; }
      case "delete_all_memories": { result = await deleteAllMemories(); break; }
      case "memory_stats": { result = await getStats(); break; }
      case "get_config": { result = JSON.stringify(getAllConfig(), null, 2); break; }
      case "update_config": { assert(typeof a.key === "string" && a.key, "key is required"); assert(typeof a.value === "string", "value is required"); setConfig(a.key, a.value); result = JSON.stringify({ updated: a.key, value: a.value }); break; }
      case "health_check": { result = await healthCheck(); break; }
      default: throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text: result }] };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
});

if (cmd === "serve") {
  await ensureCollection();
  const transports = new Map<string, SSEServerTransport>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/mcp") {
      const transport = new SSEServerTransport("/mcp/message", res);
      transports.set(transport.sessionId, transport);
      mcpServer.connect(transport);
      req.on("close", () => { transports.delete(transport.sessionId); transport.close(); });
    } else if (req.method === "POST" && req.url?.startsWith("/mcp/message")) {
      const sessionId = req.url.split("/").pop() || "";
      const transport = transports.get(sessionId);
      if (transport) await transport.handlePostMessage(req, res);
      else { res.writeHead(404).end("Session not found"); }
    } else {
      res.writeHead(404).end();
    }
  });

  writeFileSync(PID_FILE, String(process.pid));
  httpServer.listen(PORT, () => console.log("memoryhub serving on http://localhost:%d", PORT));
  process.on("SIGTERM", () => { removePid(); process.exit(0); });
  process.on("SIGINT", () => { removePid(); process.exit(0); });
} else {
  await ensureCollection();
  const transport = new StdioServerTransport();
  mcpServer.connect(transport);
}
