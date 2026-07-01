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
- Follow-up questions such as `那篇论文` / `该论文` / `Figure 1` now anchor to the last successful local document source instead of falling back to broad vector search.
- Local candidate matching now requires high-signal terms such as `adaptive-rag` when present, so generic words like `complexity` or `figure` do not pull in unrelated company PDFs or other papers.
- The frontend records pending chat streams in localStorage. If the user switches threads and returns before generation finishes, the chat shows a pending assistant reply and polls history until the saved answer appears.
- Table-oriented follow-ups now recognize `Table N`, `标签/比例/分类器预测`, and `Time/Query`. Exact lexical evidence can attach a structured table hint when PDF extraction flattens rows such as `0.358.60`, so the model preserves all requested rows and columns.
- Fuzzy Chinese descriptions such as `按问题难度选策略` now route to Adaptive-RAG via query-complexity expansions instead of relying on generic `rag` history matches. If an Ollama stream ends with no final visible text, the server retries once with a non-streamed completion before returning an error.
- Local RAG now has a first-pass document identity router for Adaptive-RAG, VisRAG, and SELF-RAG style queries. High-signal terms in the current user message can override a previous conversation anchor, so a thread can switch from one paper to another without manually naming the file path.
- Dominant document matches are pruned before chunk retrieval. This reduces citation pollution where many papers mention `SELF-RAG` or `VisRAG`, but only one local document is the actual target.
- Query planning now treats `新检索` / `重新检索` / `换一篇` / `不是这篇` as a document-anchor reset. If the reset message is too short, the previous user prompt is reused as search intent while old answer sources are not reused as anchors.
- Negated document identities such as `别沿用上一篇视觉 RAG` are no longer treated as positive VisRAG routing signals.
- Context snippets are wrapped in explicit `<wici_context>` / `<document_metadata>` / `<document_body>` boundaries so the model sees hard document-source separation instead of a flat concatenation.
- Vector sources are diversified by document before evidence selection. This caps the number of chunks one document can contribute to the broad context window, while strong document matches can still constrain the query to a single target document.
- PDF ingestion now preserves page boundary markers like `[WICI_PAGE page=N]` in `pageContent`. Newly indexed or re-indexed PDFs can carry page evidence into chunks and prompt metadata instead of losing page identity during concatenation.
- Local RAG metrics are persisted under `metrics.wiciLocalRag`, including on-demand discovery time, vector search time, rerank time, lexical evidence time, and final context source count.

## Smoke Results

Workspace: `wici-local-folder-memory`

Server: `http://localhost:3101/api`

| Case | Result |
| --- | --- |
| `2403 Adaptive-RAG` exact hint | Hit `2403.14403v2.pdf`; answered the core idea. |
| Fuzzy `Adaptive-RAG` without path/number | Hit `2403.14403v2.pdf`; answered the core idea. |
| Fuzzy Chinese `按问题难度选策略` | Hit only `2403.14403v2.pdf`; answered Adaptive-RAG's query-complexity strategy selection. |
| Wrong numeric hint `9999 Adaptive-RAG` | Returned a local miss; did not use unrelated sources. |
| `2410 VisRAG` numeric/table question | Hit `2410.10594v2.pdf`; answered `256KB`, `4.5KB`, and `5% error margin`. |
| Follow-up categories question | `那篇 Adaptive-RAG...query complexity...` now hits `2403.14403v2.pdf` and returns A/B/C with no retrieval / single-step / multi-step strategies. |
| Follow-up Figure 1 question | `那篇 Adaptive-RAG...Figure 1...` now hits `2403.14403v2.pdf` and returns `Time per Query` / `Performance (F1)`. |
| Follow-up Table 3 question | `Table 3...标签...比例...Time/Query...` hits `2403.14403v2.pdf` and returns No(A) `8.60%` / `0.35s`, One(B) `53.33%` / `3.08s`, Multi(C) `38.07%` / `27.18s`. |
| Cross-paper fuzzy switch to VisRAG | `视觉 RAG 那篇说端到端提升大概多少？` now hits only `2410.10594v2.pdf` and returns the `20-40%` end-to-end improvement. |
| Cross-paper fuzzy switch to SELF-RAG | `再换到那个自我反思的 RAG...要不要检索？` now hits only `2310.11511v1.pdf` and answers from reflection-token evidence. |
| `self 开头` alias | `那篇 self 开头的 RAG 论文里有哪些 reflection token？` hits `2310.11511v1.pdf` and returns the reflection-token table. |
| Reset / correction query | `这是一篇新的论文，需要新检索，别沿用上一篇视觉 RAG。` uses the previous SELF-RAG intent, excludes the negated VisRAG identity, and hits only `2310.11511v1.pdf`. |
| SSE payload regression | Adaptive-RAG query dropped from about 401MB to 48-57KB after source trimming, one-time source streaming, and suppressing hidden reasoning tokens. |
| Disconnect simulation | A request aborted after 1s still completed and persisted in `workspace_chats`. |

## Timing Snapshot

Example from the latest `2410 VisRAG` numeric query on the local dev box:

| Metric | Value |
| --- | ---: |
| Vector search | 716 ms |
| Local BGE rerank | 647 ms |
| Lexical evidence windows | 13 ms |
| Final context sources | 7 |

Index jobs now also report scan time and per-file timings for copy, collector parse/enrichment, previous-document removal, embedding, and total elapsed time.

## Design Boundary

This is a routing-layer improvement, not a complete local RAG architecture. It fixes the most visible failure mode where conversation history and generic chunk similarity drag a fuzzy question back to the wrong PDF. The next layer should separate document resolution from evidence planning more explicitly:

- Document registry: title, arXiv ID, aliases, abstract, source path, modality, and recent/opened-time signals.
- Query router: classify same-document follow-up vs cross-document switch vs global search/compare.
- Evidence planner: after document resolution, retrieve the right section/table/figure/formula chunks inside the selected document set.
- Structural chunk metadata: page, section, table/figure number, captions, OCR/VLM evidence, and source coordinates.

Known remaining gaps:

- Existing PDFs must be re-indexed to benefit from `[WICI_PAGE page=N]` markers.
- Workspace isolation is still inherited from AnythingLLM: LanceDB namespace is `workspace.slug`, so this is not yet a box-level global index with workspace views.
- Table/Figure answers still rely on lexical windows and a small number of structured hints. We do not yet have a full page-layout/table/figure parser with coordinates.
- Visual attribute search such as `find the stamped file` needs page-image enrichment tags like `has_stamp`, `signature`, `blank_page`, thumbnails, and possibly a visual embedding path in addition to OCR/VLM captions.

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
