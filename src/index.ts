#!/usr/bin/env node
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ensureCollection, addMemories, searchMemories, listMemories, getMemory, updateMemory, deleteMemories, deleteAllMemories, getStats, healthCheck } from "./memory.js";
import { runConfigure } from "./configure.js";
import { MEMORYHUB_DIR, QDRANT_URL, getAllConfig, setConfig } from "./config.js";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { spawn, execSync } from "node:child_process";
import os from "node:os";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const PID_FILE = join(MEMORYHUB_DIR, "hub.pid");

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

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform === "linux") {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
      if (!cmdline.includes("memoryhub") && !cmdline.includes("dist/index.js")) return false;
    } catch { return false; }
  }
  return true;
}

let cmd = process.argv[2];

function showHelp() {
  console.log(`memoryhub v${version}

Usage:
  memoryhub              Start MCP server in stdio mode
  memoryhub serve        Start HTTP/SSE server
  memoryhub start        Daemon mode (background)
  memoryhub stop         Stop daemon
  memoryhub status       Check daemon status
  memoryhub bootstrap    Serve + auto-start Qdrant if not running
  memoryhub configure    Interactive setup wizard (--set KEY=VALUE for scripted)
  memoryhub install      Install auto-start service for current user
  memoryhub uninstall    Remove auto-start service
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

function qdrantHealthUrl() {
  return QDRANT_URL.replace(/\/$/, '') + '/health';
}

async function ensureQdrant(): Promise<void> {
  try {
    const res = await fetch(qdrantHealthUrl());
    if (res.ok) return;
  } catch {}
  try {
    const child = spawn("qdrant", [], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {}
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try { if ((await fetch(qdrantHealthUrl())).ok) return; } catch {}
  }
  throw new Error("Qdrant failed to start – start it manually and retry");
}

if (cmd === "bootstrap") {
  try {
    await ensureQdrant();
  } catch (e) {
    console.error("memoryhub:", (e instanceof Error ? e.message : e));
    process.exit(1);
  }
  cmd = "serve";
}

if (cmd === "install") {
  const scriptPath = process.argv[1];
  const platform = process.platform;
  if (platform === "linux") {
    const service = `[Unit]
Description=Memory Hub MCP Server
After=network.target

[Service]
Type=simple
ExecStart="${process.execPath}" "${scriptPath}" bootstrap
Restart=on-failure

[Install]
WantedBy=default.target
`;
    const dir = join(os.homedir(), ".config/systemd/user");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "memoryhub.service"), service);
    try { execSync("systemctl --user daemon-reload", { stdio: "inherit" }); } catch { console.error("memoryhub: failed to reload systemd"); process.exit(1); }
    try { execSync("systemctl --user enable memoryhub.service", { stdio: "inherit" }); } catch { console.error("memoryhub: failed to enable service"); process.exit(1); }
    console.log("memoryhub: installed as systemd user service");
  } else if (platform === "darwin") {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.memoryhub</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${scriptPath}</string>
    <string>bootstrap</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>`;
    const dir = join(os.homedir(), "Library/LaunchAgents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "com.memoryhub.plist"), plist);
    try { execSync("launchctl unload " + join(dir, "com.memoryhub.plist"), { stdio: "ignore" }); } catch {}
    try { execSync("launchctl load " + join(dir, "com.memoryhub.plist"), { stdio: "inherit" }); } catch { console.error("memoryhub: failed to load launchd agent"); process.exit(1); }
    console.log("memoryhub: installed as launchd agent");
  } else if (platform === "win32") {
    const startupDir = join(os.homedir(), "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup");
    mkdirSync(startupDir, { recursive: true });
    const vbs = `CreateObject("WScript.Shell").Run "${process.execPath} ${scriptPath} bootstrap", 0, False`;
    writeFileSync(join(startupDir, "memoryhub.bat"), `@echo off\nstart /b "" "${process.execPath}" "${scriptPath}" bootstrap`);
    writeFileSync(join(startupDir, "memoryhub.vbs"), vbs);
    console.log("memoryhub: installed in Windows Startup folder");
  } else {
    console.log("memoryhub: unsupported platform – add manual startup: " + process.execPath + " " + scriptPath + " bootstrap");
  }
  process.exit(0);
}

if (cmd === "uninstall") {
  const platform = process.platform;
  if (platform === "linux") {
    const servicePath = join(os.homedir(), ".config/systemd/user/memoryhub.service");
    try { execSync("systemctl --user disable memoryhub.service", { stdio: "ignore" }); } catch {}
    if (existsSync(servicePath)) unlinkSync(servicePath);
    execSync("systemctl --user daemon-reload", { stdio: "ignore" });
    console.log("memoryhub: removed systemd user service");
  } else if (platform === "darwin") {
    const plistPath = join(os.homedir(), "Library/LaunchAgents/com.memoryhub.plist");
    try { execSync("launchctl unload " + plistPath, { stdio: "ignore" }); } catch {}
    if (existsSync(plistPath)) unlinkSync(plistPath);
    console.log("memoryhub: removed launchd agent");
  } else if (platform === "win32") {
    const dir = join(os.homedir(), "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup");
    for (const f of ["memoryhub.bat", "memoryhub.vbs"]) {
      const p = join(dir, f);
      if (existsSync(p)) unlinkSync(p);
    }
    console.log("memoryhub: removed from Windows Startup folder");
  }
  process.exit(0);
}

if (cmd === "start") {
  const { fork } = await import("node:child_process");
  const child = fork(process.argv[1], ["serve"], { detached: true, stdio: "ignore" });
  child.unref();
  let started = false;
  child.on("error", () => { if (!started) { console.error("memoryhub: failed to start"); process.exit(1); } });
  child.on("exit", (code) => { if (!started) { console.error(`memoryhub: exited immediately (code ${code})`); process.exit(1); } });
  await new Promise(r => setTimeout(r, 500));
  started = true;
  if (!child.pid || !process.kill(child.pid, 0)) {
    console.error("memoryhub: failed to start");
    process.exit(1);
  }
  writeFileSync(PID_FILE, String(child.pid));
  console.log("memoryhub started (PID: %d)", child.pid);
  process.exit(0);
}

if (cmd === "stop") {
  const pid = readPid();
  if (!pid) { console.log("memoryhub not running"); process.exit(0); }
  if (!isProcessAlive(pid)) { removePid(); console.log("memoryhub not running"); process.exit(0); }
  try {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (!isProcessAlive(pid)) { removePid(); console.log("memoryhub stopped"); process.exit(0); }
    }
    try { process.kill(pid, "SIGKILL"); } catch { /* not available on Windows */ }
    await new Promise(r => setTimeout(r, 500));
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
  if (isProcessAlive(pid)) {
    console.log("memoryhub: running (PID %d)", pid);
  } else { removePid(); console.log("memoryhub: stopped (stale PID)"); }
  process.exit(0);
}

if (cmd === "configure") {
  await runConfigure(process.argv.slice(3));
  process.exit(0);
}

if (cmd !== undefined && cmd !== "serve" && cmd !== "bootstrap") {
  console.error("memoryhub: unknown command '%s'", cmd);
  showHelp();
  process.exit(1);
}

const mcpServer = new Server({ name: "memoryhub", version }, { capabilities: { tools: {} } });

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "add_memories", description: "Store text (LLM extracts facts, embeds, stores).", inputSchema: { type: "object", properties: { text: { type: "string" }, project: { type: "string" } }, required: ["text"] } },
    { name: "search_memory", description: "Semantic search across stored memories.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" }, project: { type: "string" } }, required: ["query"] } },
    { name: "list_memories", description: "List stored memories with pagination.", inputSchema: { type: "object", properties: { limit: { type: "number" }, offset: { type: "string" }, project: { type: "string" } } } },
    { name: "get_memory", description: "Get a single memory by ID.", inputSchema: { type: "object", properties: { memory_id: { type: "string" } }, required: ["memory_id"] } },
    { name: "update_memory", description: "Update a memory's text (re-embeds).", inputSchema: { type: "object", properties: { memory_id: { type: "string" }, text: { type: "string" } }, required: ["memory_id", "text"] } },
    { name: "delete_memories", description: "Delete specific memories by IDs.", inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] } },
    { name: "delete_all_memories", description: "Delete ALL memories (or filter by project).", inputSchema: { type: "object", properties: { project: { type: "string" } } } },
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
      case "add_memories": {
        assert(typeof a.text === "string" && a.text, "text is required (string)");
        if (a.project !== undefined) assert(typeof a.project === "string", "project must be a string");
        result = await addMemories(a.text, a.project);
        break;
      }
      case "search_memory": {
        assert(typeof a.query === "string" && a.query, "query is required (string)");
        if (a.limit !== undefined) assert(typeof a.limit === "number" && a.limit > 0, "limit must be a positive number");
        if (a.project !== undefined) assert(typeof a.project === "string", "project must be a string");
        result = await searchMemories(a.query, a.limit ?? 10, a.project);
        break;
      }
      case "list_memories": {
        if (a.limit !== undefined) assert(typeof a.limit === "number" && a.limit > 0, "limit must be a positive number");
        if (a.offset !== undefined) assert(typeof a.offset === "string", "offset must be a string");
        if (a.project !== undefined) assert(typeof a.project === "string", "project must be a string");
        result = await listMemories(a.limit ?? 100, a.offset, a.project);
        break;
      }
      case "get_memory": { assert(typeof a.memory_id === "string" && a.memory_id, "memory_id is required (string)"); result = await getMemory(a.memory_id); break; }
      case "update_memory": {
        assert(typeof a.memory_id === "string" && a.memory_id, "memory_id is required (string)");
        assert(typeof a.text === "string" && a.text, "text is required (string)");
        result = await updateMemory(a.memory_id, a.text);
        break;
      }
      case "delete_memories": {
        assert(Array.isArray(a.ids) && a.ids.length > 0, "ids must be a non-empty array of strings");
        assert(a.ids.every((id: unknown) => typeof id === "string"), "each id must be a string");
        result = await deleteMemories(a.ids);
        break;
      }
      case "delete_all_memories": { result = await deleteAllMemories(a.project); break; }
      case "memory_stats": { result = await getStats(); break; }
      case "get_config": { result = JSON.stringify(getAllConfig(), null, 2); break; }
      case "update_config": {
        assert(typeof a.key === "string" && a.key, "key is required (string)");
        assert(typeof a.value === "string", "value is required (string)");
        setConfig(a.key, a.value);
        result = JSON.stringify({ updated: a.key, value: a.value });
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

if (cmd === "serve") {
  try { await ensureCollection(); } catch {
    console.error("memoryhub: Qdrant unreachable at " + QDRANT_URL + ". Start it or run `memoryhub bootstrap`");
    process.exit(1);
  }
  const transports = new Map<string, SSEServerTransport>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/mcp") {
      const transport = new SSEServerTransport("/mcp/message", res);
      transports.set(transport.sessionId, transport);
      mcpServer.connect(transport);
      req.on("close", () => { transports.delete(transport.sessionId); transport.close(); });
    } else if (req.method === "POST" && req.url?.startsWith("/mcp/message")) {
      const url = `http://localhost${req.url}`;
      const sessionId = new URL(url).searchParams.get("sessionId") || req.url.split("/").pop() || "";
      const transport = transports.get(sessionId);
      if (transport) await transport.handlePostMessage(req, res);
      else { res.writeHead(404).end("Session not found"); }
    } else {
      res.writeHead(404).end();
    }
  });

  writeFileSync(PID_FILE, String(process.pid));
  const port = Number(process.env.MEMORYHUB_PORT) || 9876;
  httpServer.listen(port, () => console.log("memoryhub serving on http://localhost:%d", port));

  const shutdown = async () => {
    console.log("\nmemoryhub: shutting down...");
    removePid();
    for (const t of transports.values()) {
      try { await t.close(); } catch {}
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { httpServer.closeAllConnections(); resolve(); }, 5000);
      httpServer.close(() => { clearTimeout(timeout); resolve(); });
    });
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} else {
  try { await ensureCollection(); } catch {
    console.error("memoryhub: Qdrant unreachable at " + QDRANT_URL + ". Start it or run `memoryhub bootstrap`");
    process.exit(1);
  }
  const transport = new StdioServerTransport();
  mcpServer.connect(transport);
}
