# Local RAG Query Routing Smoke Report

Date: 2026-07-01

Scope: improve the local-folder RAG path so a user can ask for local documents without giving an exact path, while avoiding broad context stuffing and UI hangs.

## What changed

- Query-driven local discovery now prefers existing indexed local-document matches before scanning and ingesting more files.
- Numeric file hints such as `2403` are treated as identity hints. They must match the file identity/path/title, not arbitrary body text.
- If an explicit numeric hint has no local candidate, the chat returns a local miss instead of falling back to unrelated vector chunks.
- When a local file match exists, exact lexical windows from that file are used as high-priority evidence and broad vector chunks from other files are excluded from the prompt context.
- Client/UI source payloads are trimmed and deduplicated separately from model evidence, so the model can see useful snippets without sending full PDF text back on every stream chunk.
- Ollama streaming now sends sources once at stream close instead of repeating sources on every token.
- Ollama `thinking` tokens are not streamed to the UI; only final answer content is streamed and persisted.
- If the browser/SSE connection closes, Ollama generation continues so the completed answer can still be persisted.

## Smoke Results

Workspace: `wici-local-folder-memory`

Server: `http://localhost:3101/api`

| Case | Result |
| --- | --- |
| `2403 Adaptive-RAG` exact hint | Hit `2403.14403v2.pdf`; answered the core idea. |
| Fuzzy `Adaptive-RAG` without path/number | Hit `2403.14403v2.pdf`; answered the core idea. |
| Wrong numeric hint `9999 Adaptive-RAG` | Returned a local miss; did not use unrelated sources. |
| `2410 VisRAG` numeric/table question | Hit `2410.10594v2.pdf`; answered `256KB`, `4.5KB`, and `5% error margin`. |
| SSE payload regression | Adaptive-RAG query dropped from about 401MB to 48-57KB after source trimming, one-time source streaming, and suppressing hidden reasoning tokens. |
| Disconnect simulation | A request aborted after 1s still completed and persisted in `workspace_chats`. |

## Re-run

With the dev server running on port 3101:

```bash
node tools/wici_local_rag_smoke.cjs
node tools/wici_local_rag_smoke.cjs --disconnect
node tools/wici_local_rag_smoke.cjs --only-disconnect
```

Optional env overrides:

```bash
WICI_SMOKE_BASE_URL=http://localhost:3101/api \
WICI_SMOKE_WORKSPACE=wici-local-folder-memory \
node tools/wici_local_rag_smoke.cjs
```
