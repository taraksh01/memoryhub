# memoryhub

MCP server for persistent memory using Qdrant vector store.

Stores text memories with LLM-generated embeddings and retrieves them via semantic search.

## Install

```bash
npm install @taraksh011/memoryhub
```

Or run directly:

```bash
npx @taraksh011/memoryhub
```

## Quick Start

```bash
# Start Qdrant (see docs/install-qdrant.md for help)
docker run -p 6333:6333 qdrant/qdrant

# Set API credentials (or run the setup wizard)
memoryhub configure

# Start memoryhub in stdio mode (for MCP clients)
memoryhub

# Or auto-start Qdrant + serve in one step
memoryhub bootstrap
```

## Prerequisites

Memory Hub needs three things:

1. **Qdrant** — vector database ([install guide](docs/install-qdrant.md))
2. **LLM API** — extracts facts from text (e.g. OpenAI, Anthropic, local Ollama)
3. **Embedding API** — converts text to vectors (e.g. OpenAI `text-embedding-3-small`, local Ollama)

**Qdrant and the embedding API are required.** The LLM is optional: if it is unset or fails, the raw text is stored as-is instead of extracted facts. The embedding config is separate from the LLM config — it does not fall back to it (see config example below). `memoryhub configure` walks you through all of them.

## Configuration

Configuration is checked in this order: **environment variable** → **config file** → **default**.

Config files are looked up in this order (first existing wins): `$MEMORYHUB_CONFIG` → `./memoryhub.json` → `~/.memoryhub/config.json`.

The config **file is hot-reloaded**: edits are picked up within ~1 second without restarting the server (a 1s watcher re-reads the file and logs `config hot-reloaded (...)`). Environment variables are read once at startup, so they still require a restart. Runtime `update_config` values keep precedence over the file until the process restarts.

### Config file

Create a `memoryhub.json` in your project root, or `config.json` in the memoryhub directory (`~/.memoryhub/` by default):

```json
{
  "qdrant": {
    "url": "http://localhost:6333"
  },
  "collection": "memories",
  "vector_size": 768,
  "retry_delay_ms": 1000,
  "dedup": {
    "enabled": true,
    "threshold": 0.85,
    "skip_threshold": 0.99
  },
  "llm": {
    "model": "gpt-4o-mini",
    "base_url": "https://api.openai.com/v1",
    "api_key": "sk-..."
  },
  "embedder": {
    "model": "text-embedding-3-small",
    "base_url": "https://api.openai.com/v1",
    "api_key": "sk-..."
  }
}
```

The `embedder` config is **required** — it does not fall back to the `llm` settings. Embedding models and chat models are usually different endpoints, so both must be configured explicitly.

### Environment variables

Short names (`LLM_BASE`, `LLM_KEY`) are preferred. Long names (`LLM_BASE_URL`, `LLM_API_KEY`) are supported for backward compatibility.

| Env Var | Short Alias | Default | Description |
|---------|-------------|---------|-------------|
| `MEMORYHUB_DIR` | — | `~/.memoryhub` | Base directory for config and data files |
| `QDRANT_URL` | — | `http://localhost:6333` | Qdrant server URL |
| `MEMORYHUB_COLLECTION` | — | `memories` | Collection name |
| `MEMORYHUB_VECTOR_SIZE` | — | `768` | Vector dimension |
| `LLM_MODEL` | — | — | LLM model for extraction |
| `LLM_BASE_URL` | `LLM_BASE` | — | LLM API base URL |
| `LLM_API_KEY` | `LLM_KEY` | — | LLM API key |
| `EMBED_MODEL` | — | — | Embedding model (required) |
| `EMBED_BASE_URL` | `EMBED_BASE` | — | Embedding API base URL (required) |
| `EMBED_API_KEY` | `EMBED_KEY` | — | Embedding API key (required) |
| `MEMORYHUB_PORT` | — | `9876` | Port for HTTP serve mode |
| `MEMORYHUB_HOST` | — | `::` | Bind host for HTTP serve mode (dual-stack by default: accepts both IPv4 and IPv6 on `::`). Set `0.0.0.0` for IPv4-only |
| `MEMORYHUB_IPV6_ONLY` | — | `false` | Set `true` to make the `::` socket IPv6-only (no IPv4 connections) |
| `MEMORYHUB_RETRY_DELAY_MS` | — | `1000` | Base retry delay for LLM/embed API calls (exponential backoff) |
| `MEMORYHUB_DEDUP_ENABLED` | — | `true` | Semantic dedup on `add_memories` (merge/skip near-duplicates) |
| `MEMORYHUB_DEDUP_THRESHOLD` | — | `0.85` | Similarity score ≥ this merges the new fact into the existing memory |
| `MEMORYHUB_DEDUP_SKIP_THRESHOLD` | — | `0.99` | Similarity score ≥ this skips the new fact entirely (identical duplicate) |
| `MEMORYHUB_API_TOKEN` | — | — | Optional bearer token. When set, the HTTP transport requires `Authorization: Bearer <token>` on every request (401 otherwise) |

## Memory Scopes

Memories can be **global** or **project-scoped**:

- Omit `project` → memory is global (visible to all searches)
- Pass `project="my-repo"` → memory is scoped to that project
- Search/list without `project` → returns all memories (global + all projects)
- Search/list with `project="my-repo"` → returns only that project's memories

Use scopes to keep memories isolated per repo, per feature, or any other boundary.

## MCP Tools

| Tool | Description | Scope Support |
|------|-------------|---------------|
| `add_memories` | Store text (LLM extracts facts, embeds them). Deduplicates near-duplicates by default. Optional `project`, `source`, `importance` (0–1), `expires_at` (ISO), `dedup` (bool), `threshold` (0–1). Returns per-memory `action`: `inserted` \| `merged` \| `skipped` | Optional `project` |
| `batch_add_memories` | Add multiple texts in one call (`items: [{text, project?, source?, importance?, expires_at?, dedup?, threshold?}]`). Per-item outcomes; item-level failures don't abort the batch | Optional `project` per item |
| `search_memory` | Semantic search with optional limit; returns full metadata per hit. Filter by `project` and/or `source`; set `exact: true` to match the query text verbatim instead of by similarity; `min_score` (0–1) drops hits below a similarity threshold (not usable with `exact: true`) | Optional `project` / `source` filter |
| `list_memories` | List memories with pagination (`limit`, `offset` as cursor from `next_offset`); newest first; filter by `project` and/or `source`; returns full metadata | Optional `project` / `source` filter |
| `get_memory` | Get a single memory by ID (full metadata) | — |
| `get_memories` | Get multiple memories by IDs | — |
| `update_memory` | Update a memory's text (re-embeds); optional `source`, `importance`, `expires_at` | — |
| `delete_memories` | Delete specific memories by IDs | — |
| `delete_all_memories` | Delete ALL memories (or filter by project) | Optional `project` filter, returns count |
| `export_memories` | Export memories as JSON (`{exported_at, count, memories}`) for backup/migration; optional `project` / `source` filters | Optional `project` / `source` filter |
| `import_memories` | Import export JSON (array or `{memories: [...]}`). Texts are re-embedded on import; original IDs and metadata are preserved | — |
| `review_stale` | Report-only audit: buckets for expired, expiring soon (`days`, default 7), and older than `older_than_days` (default 90). Optional `project` / `source` / `limit`. Never modifies data | Optional `project` / `source` filter |
| `memory_stats` | Collection statistics: totals, `by_project`, `by_source`, `expired`, `expiring_soon_7d`, `avg_age_days`, `oldest/newest_created_at`, `size_bytes` (estimate) | — |
| `get_config` | Show current runtime configuration (API keys masked) | — |
| `update_config` | Update a config value at runtime; set `persist: true` to write it atomically to the config file | — |
| `health_check` | Check connectivity to Qdrant | — |

Every memory stores `created_at`, `updated_at`, and (when provided) `project`, `source`, `expires_at`, `importance`; all read tools return these fields. Memory IDs must be UUIDs (or numeric strings) — invalid IDs are rejected with a validation error before hitting Qdrant.

> Config changes via `update_config` are in-memory only unless `persist: true` is passed (writes to `~/.memoryhub/config.json` atomically, survives restart).

## Retry

LLM and embedding API calls retry up to 3 attempts on transient errors (rate limits, server errors) with exponential backoff.

## CLI

| Command | Description |
|---------|-------------|
| `memoryhub` | Start MCP server in stdio mode |
| `memoryhub serve` | Start Streamable HTTP server |
| `memoryhub start` | Daemon mode (background) |
| `memoryhub stop` | Stop daemon |
| `memoryhub status` | Check daemon status |
| `memoryhub bootstrap` | Auto-start Qdrant if needed, then serve |
| `memoryhub configure` | Interactive setup wizard (Qdrant, LLM, embedder) with connectivity checks; `--set KEY=VALUE`, `--file`, `--no-verify` for scripted use. `--set` and `--file` support all keys including `API_TOKEN` and `DEDUP_*` |
| `memoryhub install [--start]` | Install auto-start service (systemd/launchd/Windows) pointing at the latest installed binary — package upgrades are picked up on the next boot/restart automatically, no re-run needed. `--start` also starts it immediately |
| `memoryhub uninstall` | Remove auto-start service |
| `memoryhub --help` | Show help |
| `memoryhub --version` | Show version |

## Transport Modes

- **stdio** (default): Connect MCP clients via stdin/stdout
- **Streamable HTTP**: `memoryhub serve` starts an HTTP server on port 9876 implementing the MCP Streamable HTTP transport (single `POST /mcp` endpoint, session management via `Mcp-Session-Id` header, `DELETE /mcp` to close a session). Clients must send `Accept: application/json, text/event-stream` on POST requests. The server binds to `::` **dual-stack** by default (accepts both IPv4 and IPv6) — set `MEMORYHUB_IPV6_ONLY=true` to restrict to IPv6 only, or `MEMORYHUB_HOST` to pick a specific address. Sessions idle for over 1 hour are pruned automatically.

Remote clients connect to `http://<host>:9876/mcp`. If `API_TOKEN` is set, every request must include `Authorization: Bearer <token>`; unauthenticated requests get `401`. Request bodies are capped at 5 MB (`413`).

## Build

```bash
pnpm build       # type-check + bundle
pnpm typecheck   # type-check only
pnpm dev         # run with tsx
```

## License

MIT
