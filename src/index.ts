#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ensureCollection, addMemories, searchMemories, listMemories, getMemory, updateMemory, deleteMemories, deleteAllMemories, getStats } from "./memory.js";
import { existsSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer, IncomingMessage, ServerResponse } from "node:http";

const PID_FILE = join(homedir(), ".memoryhub", "hub.pid");
const PORT = Number(process.env.MEMORYHUB_PORT) || 9876;

interface ToolArgs {
  text?: string;
  query?: string;
  limit?: number;
  memory_id?: string;
  ids?: string[];
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
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 200));
      try { process.kill(pid, 0); } catch { removePid(); console.log("memoryhub stopped"); process.exit(0); }
    }
    console.error("memoryhub did not stop, removing PID");
    removePid();
  } catch { removePid(); console.log("memoryhub not running"); }
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

const mcpServer = new Server({ name: "memoryhub", version: "0.1.0" }, { capabilities: { tools: {} } });

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "add_memories", description: "Store new memories from text.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "search_memory", description: "Search memories by semantic similarity.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number", default: 10 } }, required: ["query"] } },
    { name: "list_memories", description: "List all stored memories.", inputSchema: { type: "object", properties: {} } },
    { name: "get_memory", description: "Get a specific memory by ID.", inputSchema: { type: "object", properties: { memory_id: { type: "string" } }, required: ["memory_id"] } },
    { name: "update_memory", description: "Update a memory by ID with new text.", inputSchema: { type: "object", properties: { memory_id: { type: "string" }, text: { type: "string" } }, required: ["memory_id", "text"] } },
    { name: "delete_memories", description: "Delete memories by IDs.", inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] } },
    { name: "delete_all_memories", description: "Delete all memories.", inputSchema: { type: "object", properties: {} } },
    { name: "memory_stats", description: "Get memory statistics.", inputSchema: { type: "object", properties: {} } },
  ],
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
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
  httpServer.listen(PORT, () => console.log("memoryhub listening on port %d", PORT));

  process.on("SIGINT", () => { removePid(); process.exit(0); });
  process.on("SIGTERM", () => { removePid(); process.exit(0); });

  await new Promise(() => {});
}

await ensureCollection();
const transport = new StdioServerTransport();
await mcpServer.connect(transport);
