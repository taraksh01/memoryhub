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

# Set API credentials (or use config file)
export LLM_BASE=https://api.openai.com/v1
export LLM_KEY=sk-...
export LLM_MODEL=gpt-4o-mini

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

If your LLM and embedding APIs are the same provider, you can set just the LLM values and reuse them (see config example below).

## Configuration

Configuration is checked in this order: **config file** → **environment variable** → **default**.

### Config file

Create a `memoryhub.json` in your project root, or `config.json` in the memoryhub directory (`~/.memoryhub/` by default):

```json
{
  "qdrant": {
    "url": "http://localhost:6333"
  },
  "collection": "memories",
  "vector_size": 768,
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

If your embedder matches your LLM provider, you can omit `embedder` — it falls back to the `llm` settings.

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
| `EMBED_MODEL` | — | — | Embedding model (falls back to LLM_MODEL) |
| `EMBED_BASE_URL` | `EMBED_BASE` | — | Embedding API base URL (falls back to LLM_BASE) |
| `EMBED_API_KEY` | `EMBED_KEY` | — | Embedding API key (falls back to LLM_KEY) |
| `MEMORYHUB_PORT` | — | `9876` | Port for HTTP/SSE mode |

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
| `add_memories` | Store text (LLM extracts facts, embeds them) | Optional `project` |
| `search_memory` | Semantic search with optional limit | Optional `project` filter |
| `list_memories` | List memories with pagination (`limit`, `offset` as cursor from `next_offset`) | Optional `project` filter |
| `get_memory` | Get a single memory by ID | — |
| `update_memory` | Update a memory's text (re-embeds) | — |
| `delete_memories` | Delete specific memories by IDs | — |
| `delete_all_memories` | Delete ALL memories (or filter by project) | Optional `project` filter, returns count |
| `memory_stats` | Collection statistics | — |
| `get_config` | Show current runtime configuration (API keys masked) | — |
| `update_config` | Update a config value at runtime (not persisted) | — |
| `health_check` | Check connectivity to Qdrant | — |

> Config changes via `update_config` are in-memory only — lost on restart. Use config file or env vars for permanent changes.

## Retry

LLM and embedding API calls retry up to 3 times on transient errors (rate limits, server errors) with exponential backoff.

## CLI

| Command | Description |
|---------|-------------|
| `memoryhub` | Start MCP server in stdio mode |
| `memoryhub serve` | Start HTTP/SSE server |
| `memoryhub start` | Daemon mode (background) |
| `memoryhub stop` | Stop daemon |
| `memoryhub status` | Check daemon status |
| `memoryhub bootstrap` | Auto-start Qdrant if needed, then serve |
| `memoryhub install` | Install auto-start service (systemd/launchd/Windows) |
| `memoryhub uninstall` | Remove auto-start service |
| `memoryhub --help` | Show help |
| `memoryhub --version` | Show version |

## Transport Modes

- **stdio** (default): Connect MCP clients via stdin/stdout
- **HTTP/SSE**: `memoryhub serve` starts an HTTP server on port 9876

## Build

```bash
pnpm build       # type-check + bundle
pnpm typecheck   # type-check only
pnpm dev         # run with tsx
```

## License

MIT
