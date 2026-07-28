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
# Start Qdrant (Docker)
docker run -p 6333:6333 qdrant/qdrant

# Start memoryhub in stdio mode (for MCP clients)
memoryhub

# Or as a daemon
memoryhub start
memoryhub status
memoryhub stop
```

## Prerequisites

Memory Hub needs three things:

1. **Qdrant** — vector database for storing memories
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

| Env Var | Default | Description |
|---------|---------|-------------|
| `MEMORYHUB_DIR` | `~/.memoryhub` | Base directory for config and data files |
| `QDRANT_URL` | `http://localhost:6333` | Qdrant server URL |
| `MEMORYHUB_COLLECTION` | `memories` | Collection name |
| `MEMORYHUB_VECTOR_SIZE` | `768` | Vector dimension |
| `LLM_MODEL` | — | LLM model for extraction |
| `LLM_BASE_URL` | — | LLM API base URL |
| `LLM_API_KEY` | — | LLM API key |
| `EMBED_MODEL` | — | Embedding model (falls back to LLM_MODEL) |
| `EMBED_BASE_URL` | — | Embedding API base URL (falls back to LLM_BASE_URL) |
| `EMBED_API_KEY` | — | Embedding API key (falls back to LLM_API_KEY) |
| `MEMORYHUB_PORT` | `9876` | Port for HTTP/SSE mode |

## MCP Tools

| Tool | Description |
|------|-------------|
| `add_memories` | Store text (LLM extracts facts, embeds them) |
| `search_memory` | Semantic search with optional limit |
| `list_memories` | List all stored memories |
| `get_memory` | Get a single memory by ID |
| `update_memory` | Update a memory's text (re-embeds) |
| `delete_memories` | Delete specific memories by IDs |
| `delete_all_memories` | Delete ALL memories |
| `memory_stats` | Collection statistics |

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
