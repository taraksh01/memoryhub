import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { randomUUID } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";

export interface HttpHandle {
  httpServer: ReturnType<typeof createServer>;
  close: () => Promise<void>;
}

export interface HttpServerOptions {
  sessionIdleMs?: number;
}

const DEFAULT_SESSION_IDLE_MS = 60 * 60 * 1000;

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

function sessionIdFrom(req: IncomingMessage): string | undefined {
  const h = req.headers["mcp-session-id"];
  return typeof h === "string" ? h : undefined;
}

export function createHttpServer(serverFactory: () => McpServer, options: HttpServerOptions = {}): HttpHandle {
  const sessions = new Map<string, Session>();
  const idleMs = options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
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
      if (!res.headersSent) res.writeHead(500).end(e instanceof Error ? e.message : "Internal error");
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
