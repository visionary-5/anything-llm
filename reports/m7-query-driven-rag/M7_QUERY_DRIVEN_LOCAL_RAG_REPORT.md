# M7 Query-Driven Local RAG Report

Date: 2026-07-01

## Goal

Make local memory feel closer to "ask the agent" instead of "manually index everything first".

This pass adds two server-side improvements:

- Query-driven local source indexing: when a query asks for local files/PDFs/images, scan common user roots and ingest only a few likely candidates.
- Exact local evidence windows: after vector recall finds a document, reopen the full parsed document and inject high-scoring lexical windows before broad vector chunks for exact numbers, formulas, tables, and metric definitions.

## What Changed

- `server/utils/wiciLocalSources/index.js`
  - Added query-time local indexing gate.
  - Defaults to `Documents`, `Downloads`, and `Desktop`; adds `Pictures` only for image intent.
  - Avoids processing code/data files such as README/JSON/CSV unless the query explicitly asks for code/data or the filename/path strongly matches.
  - Skips on-demand indexing when an already indexed local document strongly matches the query, for example `2410` or `VisRAG`.

- `server/utils/wiciLocalRag/index.js`
  - Added exact lexical evidence extraction from full parsed documents.
  - Resolves vector search sources back to `workspace_documents.docpath` using workspace metadata, even when LanceDB results only have `title` and `chunkSource`.
  - Boosts windows containing memory comparison evidence and numeric tolerance definitions.

- `server/utils/chats/*`
  - Runs on-demand indexing before vector search.
  - Prepends exact evidence windows before vector chunks.
  - Returns `wiciLocalIndex` in API/stream responses for observability.
  - Updates the local-RAG system prompt so exact evidence is higher priority than broad vector chunks.

- `server/utils/vectorDbProviders/lance/index.js`
  - Uses larger local-document chunks by default for WICI local sources.

## Reproduction

Server:

```bash
cd anything-llm/server
NODE_ENV=development node index.js
```

Ask the local-memory workspace:

```bash
API_KEY=$(sqlite3 server/storage/anythingllm.db "select secret from api_keys limit 1;")
curl -sS -X POST http://127.0.0.1:3101/api/v1/workspace/wici-local-folder-memory/chat \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"mode":"query","message":"我最近看了一篇论文，以2410开头，是讲visrag的，论文用什么具体数字论证 VisRAG-Ret 比 ColPali 更省内存? 评估指标里,数值型答案允许多大的误差容限?"}'
```

## Verified Result

The API returned the correct answer from:

`file:///Users/saprk/Documents/2410.10594v2.pdf`

Answer highlights:

- ColPali represents a page with `256KB` across `1030` 128-dimensional vectors.
- VisRAG-Ret uses `4.5KB` in a single 2304-dimensional vector.
- Numeric responses use relaxed exact match with a `5% error margin`.

Observed local indexing metadata:

```json
{
  "indexed": 0,
  "attempted": 0,
  "skipped": true,
  "reason": "indexed_candidate_exists",
  "elapsedMs": 6
}
```

That means the query did not trigger unrelated re-indexing once the matching local PDF was already indexed.

## Cleanup

Removed the old `wici-local-dir-demo` workspace and its WICI local-source state. The active demo workspace is now:

- `wici-local-folder-memory`

## Remaining Limitations

- This is still a text-first PDF path. It improves exact retrieval from extracted text, but does not yet run a page-level VLM over PDF figures/tables/formulas.
- Query-driven ingestion currently chooses a small candidate set from common roots. A box-grade version should add a lightweight file catalog with metadata-first search, then enrich only the selected candidates.
- Existing broad chunks stay as-is until documents are re-indexed; exact evidence windows compensate for this at query time.
