#!/usr/bin/env node
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ensureCollection } from "./memory.js";
import { createMcpServer } from "./mcp.js";
import { createHttpServer } from "./http.js";
import { runConfigure } from "./configure.js";
import { MEMORYHUB_DIR, getConfig, onConfigChange } from "./config.js";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { spawn, execSync } from "node:child_process";
import os from "node:os";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const PID_FILE = join(MEMORYHUB_DIR, "hub.pid");

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

function findServerProcess(): number | null {
  if (process.platform !== "linux") return null;
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid === process.pid) continue;
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0/g, " ");
        if (cmdline.includes("index.js serve") || cmdline.includes("index.js bootstrap")) return pid;
      } catch {}
    }
  } catch {}
  return null;
}

function killProcess(pid: number): boolean {
  try {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 25; i++) {
      awaitDelay(200);
      if (!isProcessAlive(pid)) return true;
    }
    try { process.kill(pid, "SIGKILL"); } catch {}
    awaitDelay(500);
    return !isProcessAlive(pid);
  } catch { return false; }
}

function awaitDelay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

let cmd = process.argv[2];

function showHelp() {
  console.log(`memoryhub v${version}

Usage:
  memoryhub              Start MCP server in stdio mode
  memoryhub serve        Start Streamable HTTP server
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
  return getConfig("QDRANT_URL").replace(/\/$/, '') + '/healthz';
}

function qdrantProbe(): Promise<Response> {
  return fetch(qdrantHealthUrl(), { signal: AbortSignal.timeout(3000) });
}

onConfigChange(async (changedKeys) => {
  if (!changedKeys.some((k) => k === "COLLECTION" || k === "VECTOR_SIZE")) return;
  try {
    await ensureCollection();
    console.log("memoryhub: collection verified after config reload");
  } catch (err) {
    console.error("memoryhub: collection check failed after config reload: " + (err instanceof Error ? err.message : err));
  }
});

async function ensureQdrant(): Promise<void> {
  try {
    const res = await qdrantProbe();
    if (res.ok) return;
  } catch {}
  try {
    const child = spawn("qdrant", [], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {}
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try { if ((await qdrantProbe()).ok) return; } catch {}
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
  const existing = readPid();
  if (existing && isProcessAlive(existing)) {
    console.error(`memoryhub: already running (PID ${existing}) — use "memoryhub status"`);
    process.exit(1);
  }
  const portHolder = findServerProcess();
  if (portHolder) {
    console.error(`memoryhub: port already in use by an untracked instance (PID ${portHolder}) — run "memoryhub stop" first`);
    process.exit(1);
  }
  const logPath = join(MEMORYHUB_DIR, "memoryhub.log");
  let logFd: number | undefined;
  try { logFd = openSync(logPath, "a"); } catch {}
  const child = fork(process.argv[1], ["serve"], { detached: true, stdio: ["ignore", "ignore", logFd ?? "ignore", "ipc"] });
  child.unref();
  let started = false;
  child.on("error", () => { if (!started) { console.error("memoryhub: failed to start"); process.exit(1); } });
  child.on("exit", (code) => {
    if (!started) {
      let tail = "";
      try {
        tail = readFileSync(logPath, "utf-8").trim().split("\n").slice(-10).join("\n");
      } catch {}
      console.error(`memoryhub: failed to start (code ${code})${tail ? `:\n${tail}` : ""}`);
      process.exit(1);
    }
  });
  await new Promise(r => setTimeout(r, 500));
  started = true;
  if (!child.pid || !process.kill(child.pid, 0)) {
    console.error("memoryhub: failed to start");
    process.exit(1);
  }
  writeFileSync(PID_FILE, String(child.pid));
  console.log(`memoryhub started (PID: %d) — logs: ${logPath}`, child.pid);
  process.exit(0);
}

if (cmd === "stop") {
  const pid = readPid();
  if (!pid || !isProcessAlive(pid)) {
    const untracked = findServerProcess();
    if (untracked && killProcess(untracked)) {
      removePid();
      console.log(`memoryhub stopped (PID ${untracked})`);
    } else {
      removePid();
      console.log("memoryhub not running");
    }
    process.exit(0);
  }
  if (killProcess(pid)) {
    removePid();
    console.log("memoryhub stopped");
  } else {
    removePid();
    console.log("memoryhub not running");
  }
  process.exit(0);
}

if (cmd === "status") {
  const pid = readPid();
  if (pid && isProcessAlive(pid)) {
    console.log("memoryhub: running (PID %d)", pid);
  } else {
    const untracked = findServerProcess();
    if (untracked) console.log("memoryhub: running (PID %d, not tracked in PID file)", untracked);
    else console.log("memoryhub: stopped");
    if (pid) removePid();
  }
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

if (cmd === "serve") {
  try { await ensureCollection(); } catch (err) {
    console.error("memoryhub: Qdrant check failed: " + (err instanceof Error ? err.message : err));
    process.exit(1);
  }
  const { httpServer, close } = createHttpServer(() => createMcpServer(version));

  const port = Number(process.env.MEMORYHUB_PORT) || 9876;
  httpServer.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error(`memoryhub: port ${port} already in use — is another instance running? Check "memoryhub status"`);
    } else {
      console.error("memoryhub: server error: " + err.message);
    }
    process.exit(1);
  });
  httpServer.listen(port, () => {
    writeFileSync(PID_FILE, String(process.pid));
    console.log("memoryhub serving on http://localhost:%d", port);
  });

  const shutdown = async () => {
    console.log("\nmemoryhub: shutting down...");
    removePid();
    await close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} else {
  try { await ensureCollection(); } catch (err) {
    console.error("memoryhub: Qdrant check failed: " + (err instanceof Error ? err.message : err));
    process.exit(1);
  }
  const mcpServer = createMcpServer(version);
  const transport = new StdioServerTransport();
  mcpServer.connect(transport);
}
