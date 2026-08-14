import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { randomUUID } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { getConfig } from "./config.js";

export interface HttpHandle {
  httpServer: ReturnType<typeof createServer>;
  close: () => Promise<void>;
}

export interface HttpServerOptions {
  sessionIdleMs?: number;
}

const DEFAULT_SESSION_IDLE_MS = 60 * 60 * 1000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

function sessionIdFrom(req: IncomingMessage): string | undefined {
  const h = req.headers["mcp-session-id"];
  return typeof h === "string" ? h : undefined;
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, { "WWW-Authenticate": 'Bearer realm="memoryhub"' }).end("Unauthorized: set the Authorization: Bearer <token> header");
}

function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const token = getConfig("API_TOKEN");
  if (!token) return true;
  const header = req.headers["authorization"];
  if (typeof header !== "string") {
    unauthorized(res);
    return false;
  }
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || value !== token) {
    unauthorized(res);
    return false;
  }
  return true;
}

function enforceBodyLimit(req: IncomingMessage, res: ServerResponse): void {
  let bytes = 0;
  req.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      if (!res.headersSent) res.writeHead(413).end("Payload too large");
      req.destroy();
    }
  });
}

export function createHttpServer(serverFactory: () => McpServer, options: HttpServerOptions = {}): HttpHandle {
  const sessions = new Map<string, Session>();
  const idleMs = options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method === "POST" && req.headers["content-length"] && Number(req.headers["content-length"]) > MAX_BODY_BYTES) {
        res.writeHead(413).end("Payload too large");
        return;
      }
      if (req.method === "POST" && !req.headers["content-length"]) enforceBodyLimit(req, res);
      if (!checkAuth(req, res)) return;
      if (req.method === "GET" && req.url === "/mcp") {
        const sessionId = sessionIdFrom(req);
        const session = sessionId ? sessions.get(sessionId) : undefined;
        if (!session) {
          res.writeHead(400).end("Bad Request: Invalid or missing session ID");
          return;
        }
        session.lastSeen = Date.now();
        await session.transport.handleRequest(req, res);
      } else if (req.method === "POST" && req.url === "/mcp") {
        const sessionId = sessionIdFrom(req);
        let session = sessionId ? sessions.get(sessionId) : undefined;
        if (sessionId && !session) {
          res.writeHead(404).end("Session not found");
          return;
        }
        if (!session) {
          const server = serverFactory();
          let created: StreamableHTTPServerTransport | undefined;
          created = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              if (created) sessions.set(id, { server, transport: created, lastSeen: Date.now() });
            },
          });
          session = { server, transport: created, lastSeen: Date.now() };
          created.onclose = () => {
            if (created?.sessionId) sessions.delete(created.sessionId);
          };
          await server.connect(created);
        }
        session.lastSeen = Date.now();
        await session.transport.handleRequest(req, res);
      } else if (req.method === "DELETE" && req.url === "/mcp") {
        const sessionId = sessionIdFrom(req);
        const session = sessionId ? sessions.get(sessionId) : undefined;
        if (!sessionId || !session) {
          res.writeHead(400).end("Bad Request: Invalid or missing session ID");
          return;
        }
        session.lastSeen = Date.now();
        await session.transport.close();
        sessions.delete(sessionId);
        res.writeHead(200).end("Session closed");
      } else {
        res.writeHead(404).end("Not found");
      }
    } catch (e) {
      console.error("memoryhub: request error: " + (e instanceof Error ? e.message : String(e)));
      if (!res.headersSent) res.writeHead(500).end("Internal error");
    }
  });

  const prune = () => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastSeen > idleMs) {
        try { s.transport.close(); } catch {}
        sessions.delete(id);
        console.error(`memoryhub: pruned idle session ${id}`);
      }
    }
  };
  const pruneTimer = setInterval(prune, Math.max(500, Math.min(60_000, idleMs / 2)));
  pruneTimer.unref();

  const close = async () => {
    const closeSession = async (s: Session) => {
      try {
        await Promise.race([
          s.transport.close(),
          new Promise((r) => setTimeout(r, 2000)),
        ]);
      } catch {}
    };
    await Promise.all([...sessions.values()].map(closeSession));
    sessions.clear();
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { httpServer.closeAllConnections(); resolve(); }, 5000);
      httpServer.close(() => { clearTimeout(timeout); resolve(); });
    });
  };

  return { httpServer, close };
}
