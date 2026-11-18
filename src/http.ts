import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { randomUUID } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { getConfig, getAllConfig, setConfig, persistConfig, mask } from "./config.js";
import { DASHBOARD_HTML } from "./dashboard.js";
import { getStats, listMemories, searchMemories, relatedMemories, graphMemories, reviewStale, linkMemories, unlinkMemories, addMemories, updateMemory, deleteMemories, duplicatePairs } from "./memory.js";

export interface HttpHandle {
  httpServer: ReturnType<typeof createServer>;
  close: () => Promise<void>;
}

export interface HttpServerOptions {
  sessionIdleMs?: number;
}

const PENDING_SESSION_TTL_MS = 30 * 1000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_SESSIONS = 100;

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
  if (scheme?.toLowerCase() !== "bearer" || !value) {
    unauthorized(res);
    return false;
  }
  const tokenBuf = Buffer.from(token);
  const valueBuf = Buffer.from(value);
  if (tokenBuf.length !== valueBuf.length || !timingSafeEqual(tokenBuf, valueBuf)) {
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

function lazyExpired(sessions: Map<string, Session>, sessionId: string | undefined, idleMs: number, now: number): Session | undefined {
  if (!sessionId || idleMs <= 0) return sessionId ? sessions.get(sessionId) : undefined;
  const s = sessions.get(sessionId);
  if (!s) return undefined;
  if (now - s.lastSeen >= idleMs) {
    try { s.transport.close(); } catch {}
    sessions.delete(sessionId);
    console.error(`memoryhub: evicted idle session ${sessionId} (${now - s.lastSeen}ms idle)`);
    return undefined;
  }
  return s;
}

function checkDashboardAuth(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const token = getConfig("API_TOKEN");
  if (!token) return true;
  const header = req.headers["authorization"];
  const fromHeader = typeof header === "string" && header.toLowerCase().startsWith("bearer ") ? header.slice(7) : undefined;
  const value = fromHeader ?? url.searchParams.get("token") ?? undefined;
  if (!value) {
    unauthorized(res);
    return false;
  }
  const a = Buffer.from(token);
  const b = Buffer.from(value);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    unauthorized(res);
    return false;
  }
  return true;
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function handleDashboardApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const q = url.searchParams;
  const num = (key: string, fallback: number): number => {
    const v = Number(q.get(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const send = (payload: string | object): void => {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
      .end(typeof payload === "string" ? payload : JSON.stringify(payload));
  };
  try {
    if (req.method === "GET" && url.pathname === "/api/stats") {
      send(await getStats());
    } else if (req.method === "GET" && url.pathname === "/api/memories") {
      const project = q.get("project") || undefined;
      const source = q.get("source") || undefined;
      const limit = num("limit", 50);
      const query = q.get("q");
      if (query) {
        const found = JSON.parse(await searchMemories(query, limit, project, { source, exact: q.get("exact") === "true" }));
        send({ memories: found, next_offset: null, mode: "search" });
      } else {
        const page = JSON.parse(await listMemories(limit, q.get("offset") || undefined, project, source));
        send({ memories: page.memories ?? [], next_offset: page.next_offset ?? null, mode: "list" });
      }
    } else if (req.method === "GET" && url.pathname === "/api/related") {
      const id = q.get("id");
      if (!id) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "id is required" }));
      } else {
        send(await relatedMemories(id, num("limit", 6)));
      }
    } else if (req.method === "GET" && url.pathname === "/api/graph") {
      send(await graphMemories(Number(q.get("threshold")) || 0.55, num("maxNodes", 250), num("neighbors", 4)));
    } else if (req.method === "GET" && url.pathname === "/api/stale") {
      send(await reviewStale({
        project: q.get("project") || undefined,
        source: q.get("source") || undefined,
        days: num("days", 7),
        older_than_days: num("older_than_days", 90),
        limit: num("limit", 25),
      }));
    } else if (url.pathname === "/api/links" && (req.method === "POST" || req.method === "DELETE")) {
      const body = await readJsonBody(req);
      const id = typeof body.id === "string" ? body.id : "";
      const linkIds = Array.isArray(body.linkIds) ? body.linkIds.filter((x): x is string => typeof x === "string") : [];
      if (!id || linkIds.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "id and linkIds are required" }));
      } else {
        send(req.method === "POST" ? await linkMemories(id, linkIds) : await unlinkMemories(id, linkIds));
      }
    } else if (url.pathname === "/api/memories" && req.method === "POST") {
      const body = await readJsonBody(req);
      const text = typeof body.text === "string" ? body.text : "";
      if (!text.trim()) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "text is required" }));
      } else {
        send(JSON.parse(await addMemories(text, typeof body.project === "string" ? body.project : undefined, {
          source: typeof body.source === "string" ? body.source : undefined,
          importance: typeof body.importance === "number" ? body.importance : undefined,
          expires_at: typeof body.expires_at === "string" ? body.expires_at : undefined,
          dedup: typeof body.dedup === "boolean" ? body.dedup : undefined,
          threshold: typeof body.threshold === "number" ? body.threshold : undefined,
        })));
      }
    } else if (url.pathname === "/api/memories" && req.method === "PATCH") {
      const body = await readJsonBody(req);
      const id = typeof body.id === "string" ? body.id : "";
      const text = typeof body.text === "string" ? body.text : "";
      if (!id || !text.trim()) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "id and text are required" }));
      } else {
        send(JSON.parse(await updateMemory(id, text, {
          source: typeof body.source === "string" ? body.source : undefined,
          importance: typeof body.importance === "number" ? body.importance : undefined,
          expires_at: typeof body.expires_at === "string" ? body.expires_at : undefined,
        })));
      }
    } else if (url.pathname === "/api/memories" && req.method === "DELETE") {
      const id = q.get("id");
      if (!id) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "id is required" }));
      } else {
        send(JSON.parse(await deleteMemories([id])));
      }
    } else if (req.method === "GET" && url.pathname === "/api/duplicates") {
      send(await duplicatePairs(Number(q.get("threshold")) || 0.98, num("maxNodes", 500), num("limit", 50)));
    } else if (req.method === "GET" && url.pathname === "/api/config") {
      send({ config: getAllConfig() });
    } else if (req.method === "POST" && url.pathname === "/api/config") {
      const body = await readJsonBody(req);
      const key = typeof body.key === "string" ? body.key : "";
      const value = typeof body.value === "string" ? body.value : "";
      const persist = body.persist === true;
      if (!key) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "key is required" }));
      } else {
        const secret = key === "LLM_KEY" || key === "EMBED_KEY" || key === "API_TOKEN";
        if (persist) {
          const path = persistConfig(key, value);
          const effective = getConfig(key);
          send({ updated: key, value: secret ? mask(effective) : effective, persisted: true, path });
        } else {
          setConfig(key, value);
          const effective = getConfig(key);
          send({ updated: key, value: secret ? (effective === "" ? "" : mask(effective)) : effective, persisted: false });
        }
      }
    } else {
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!res.headersSent) res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: message }));
  }
}

export function createHttpServer(serverFactory: () => McpServer, options: HttpServerOptions = {}): HttpHandle {
  const sessions = new Map<string, Session>();
  const pending = new Map<StreamableHTTPServerTransport, number>();
  const idleMs = options.sessionIdleMs ?? (Number(getConfig("SESSION_IDLE_MS")) || 0);

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method === "POST" && req.headers["content-length"] && Number(req.headers["content-length"]) > MAX_BODY_BYTES) {
        res.writeHead(413).end("Payload too large");
        return;
      }
      if (req.method === "POST" && !req.headers["content-length"]) enforceBodyLimit(req, res);

      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname;

      // Dashboard + JSON API (token accepted via header or ?token= when set).
      if (pathname === "/" || pathname === "/dashboard" || pathname.startsWith("/api/")) {
        if (!checkDashboardAuth(req, res, url)) return;
        if (pathname === "/" || pathname === "/dashboard") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(DASHBOARD_HTML);
        } else {
          await handleDashboardApi(req, res, url);
        }
        return;
      }

      if (!checkAuth(req, res)) return;
      if (req.method === "GET" && pathname === "/mcp") {
        const sessionId = sessionIdFrom(req);
        const session = lazyExpired(sessions, sessionId, idleMs, Date.now());
        if (!session) {
          res.writeHead(400).end("Bad Request: Invalid or missing session ID");
          return;
        }
        session.lastSeen = Date.now();
        await session.transport.handleRequest(req, res);
      } else if (req.method === "POST" && pathname === "/mcp") {
        const sessionId = sessionIdFrom(req);
        let session = lazyExpired(sessions, sessionId, idleMs, Date.now());
        if (sessionId && !session) {
          res.writeHead(404).end("Session not found");
          return;
        }
        if (!session) {
          if (sessions.size + pending.size >= MAX_SESSIONS) {
            let lruId: string | undefined;
            let lruSeen = Infinity;
            for (const [id, s] of sessions) {
              if (s.lastSeen < lruSeen) {
                lruSeen = s.lastSeen;
                lruId = id;
              }
            }
            if (lruId) {
              const victim = sessions.get(lruId)!;
              try { victim.transport.close(); } catch {}
              sessions.delete(lruId);
              console.error(`memoryhub: evicted least-recently-used session ${lruId}`);
            } else {
              res.writeHead(429).end("Too many sessions");
              return;
            }
          }
          const server = serverFactory();
          let created: StreamableHTTPServerTransport | undefined;
          created = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              if (created) {
                pending.delete(created);
                sessions.set(id, { server, transport: created, lastSeen: Date.now() });
              }
            },
          });
          session = { server, transport: created, lastSeen: Date.now() };
          pending.set(created, Date.now());
          created.onclose = () => {
            pending.delete(created!);
            if (created?.sessionId) sessions.delete(created.sessionId);
          };
          try {
            await server.connect(created);
          } catch (e) {
            pending.delete(created);
            throw e;
          }
        }
        session.lastSeen = Date.now();
        await session.transport.handleRequest(req, res);
      } else if (req.method === "DELETE" && pathname === "/mcp") {
        const sessionId = sessionIdFrom(req);
        const session = lazyExpired(sessions, sessionId, idleMs, Date.now());
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
    if (idleMs > 0) {
      for (const [id, s] of sessions) {
        if (now - s.lastSeen >= idleMs) {
          try { s.transport.close(); } catch {}
          sessions.delete(id);
          console.error(`memoryhub: pruned idle session ${id}`);
        }
      }
    }
    for (const [t, created] of pending) {
      if (now - created > PENDING_SESSION_TTL_MS) {
        try { t.close(); } catch {}
        pending.delete(t);
        console.error("memoryhub: pruned uninitialized session");
      }
    }
  };
  const sweepMs = idleMs > 0 ? Math.min(idleMs / 2, 60_000) : Math.min(PENDING_SESSION_TTL_MS / 2, 60_000);
  const pruneTimer = setInterval(prune, Math.max(500, sweepMs));
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
    for (const t of pending.keys()) { try { await t.close(); } catch {} }
    pending.clear();
    sessions.clear();
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { httpServer.closeAllConnections(); resolve(); }, 5000);
      httpServer.close(() => { clearTimeout(timeout); resolve(); });
    });
  };

  return { httpServer, close };
}
