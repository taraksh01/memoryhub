# memoryhub

MCP server for persistent memory using Qdrant vector store.

Stores text memories with LLM-generated embeddings and retrieves them via semantic search.

## Prerequisites

- [Qdrant](https://qdrant.tech/) running at `http://localhost:6333` (or set `QDRANT_URL`)
- OpenAI-compatible LLM and embedding API endpoints

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

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `QDRANT_URL` | `http://localhost:6333` | Qdrant server URL |
| `MEMORYHUB_COLLECTION` | `memories` | Collection name |
| `MEMORYHUB_VECTOR_SIZE` | `768` | Vector dimension |
| `LLM_MODEL` | `""` | LLM model for extraction |
| `LLM_BASE_URL` | `""` | LLM API base URL |
| `LLM_API_KEY` | `""` | LLM API key |
| `EMBED_MODEL` | `""` | Embedding model |
| `EMBED_BASE_URL` | `""` | Embedding API base URL |
| `EMBED_API_KEY` | `""` | Embedding API key |
| `MEMORYHUB_PORT` | `9876` | Port for HTTP/SSE mode |

Config file: `memoryhub.json` in current directory or `~/.memoryhub/config.json`.

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
