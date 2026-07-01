# M9 Local RAG Architecture + Index Audit

Date: 2026-07-01

## What Changed

- Query planner is now null-safe. A bad or empty planner response no longer crashes with `Cannot read properties of null (reading 'positive_concepts')`.
- Local search has two explicit user-facing fallbacks:
  - local search failure: planning/indexing crashed or timed out
  - local search miss: search ran, but no reliable evidence exists in the indexed local corpus
- Local file/image search no longer inherits previous paper-thread context. This avoids asking for a black-cat image and receiving VisRAG/Adaptive-RAG paper evidence.
- Full-home scans now skip obvious runtime/dev noise by default: this fork's hotdir/storage, m9 raw reports, upstream research references, generated reports, and nested git repos unless explicitly selected.
- On-demand image search no longer randomly enriches one photo when the query has no filename/path signal. Pure content image search now depends on the background visual index, which is the correct architecture.
- Pure image-content search with no candidate now returns `strictLocalMiss=true` before vector recall. This prevents unrelated indexed photos from being used to "prove" a match.
- Added reproducible audit tools:
  - `tools/wici_full_disk_index_audit.cjs`
  - `tools/wici_local_search_probe.cjs`

## Architecture State

The current local RAG path is:

1. Query planner decides intent, scope, file types, visual tags, and rewritten concepts.
2. Local source layer checks existing indexed state for strong document/file matches.
3. If needed, on-demand indexing may enrich a small candidate set.
4. Vector recall + rerank + lexical evidence assemble context.
5. The answer is constrained by local evidence; failures and misses are returned as user-readable responses with `wiciLocalRag` metadata.

The design is intentionally moving toward "heavy background enrichment, light query":

- Full inventory/scan is cheap.
- OCR/VLM/collector enrichment is expensive.
- Embedding is cheap relative to enrichment.
- Query-time should primarily select, filter, rerank, and cite already-enriched evidence.

## Scan Results

Home-wide preview (`~`):

- Seen files: 15,783 before path hygiene
- Changed/new: 15,559 before path hygiene
- Seen files: 12,798 after path hygiene
- Changed/new: 12,740 after path hygiene
- Scan time after path hygiene: 128 ms
- Truncated: false

User-files preview (`Documents`, `Downloads`, `Desktop`, `Pictures`):

- Seen files: 1,355
- Changed/new: 1,324
- Scan time: 60 ms
- Truncated: false

## Index Timing

Real user-files index batch:

- Scope: `~/Documents`, `~/Downloads`, `~/Desktop`, `~/Pictures`
- Limit: 100 changed/new candidates
- Success: 99
- Failed: 1
- Total elapsed: 420.6 s
- Average successful file: 4.236 s
- Average collector/OCR/VLM time: 4.184 s
- Average embedding time: 50 ms

Conclusion: the bottleneck is collector enrichment, especially VLM/OCR/image/PDF parsing. It is not LanceDB search and not embedding.

One failure was `Documents/a.pdf` with `A processing error occurred.` It is recorded as a failed fingerprint, so the same unchanged file will not be retried indefinitely.

## Probe Results

The probe ran 8 mixed prompts after the 100-file index batch.

- Adaptive-RAG overview: answered correctly, about 11.9 s.
- Adaptive-RAG Figure 1 axes: answered from `2403.14403v2.pdf`, about 20.2 s.
- VisRAG TextRAG information loss: answered from `2410.10594v2.pdf`, about 14.0 s.
- VisRAG Figure 1 numbers: answered from `2410.10594v2.pdf`, about 22.2 s.
- Camera + phone image: no crash; final behavior is strict local miss, `indexed=0`, `attempted=0`, no vector/rerank fallback.
- Black cat near sink/bathroom: no crash; final behavior is strict local miss, `indexed=0`, `attempted=0`, no vector/rerank fallback.
- Stamped file: found `Documents/b.pdf` as a top local match with stamp/seal tags, about 14.5 s.
- Blank file: still imperfect. It surfaces mostly-blank stamped documents because `blank_page/mostly_blank` currently means page layout, not true empty-file semantics.

## Current Limitations

- Full user-files enrichment is hour-scale on this Mac. Based on 1,324 changed/new candidates and the 100-file batch average, a full pass is roughly 1.5 hours if the remaining files behave similarly.
- Image content search cannot be magic before visual enrichment. Without a completed image caption index, query-time search should not randomly index photos.
- The correct next step for robust image search is a background visual enrichment job with progress, not larger prompt context or random query-time enrichment.
- "Blank file" needs a separate semantic distinction:
  - true empty or near-empty document
  - mostly blank page with a stamp/seal
  - document parser failure
- Source citations still need UI-level review. The backend context is stronger than before, but the visible source list can be sparse in streaming finalization.

## Reproduce

Start server and collector, then run:

```bash
node tools/wici_full_disk_index_audit.cjs --dry-run --roots ~ --limit 0 --report reports/m9-full-disk-index/full_disk_preview_after_skip.json
node tools/wici_full_disk_index_audit.cjs --dry-run --roots ~/Documents,~/Downloads,~/Desktop,~/Pictures --limit 0 --report reports/m9-full-disk-index/user_files_preview.json
node tools/wici_full_disk_index_audit.cjs --roots ~/Documents,~/Downloads,~/Desktop,~/Pictures --limit 100 --report reports/m9-full-disk-index/user_files_index_100.json --timeout-ms 7200000 --poll-ms 5000
node tools/wici_local_search_probe.cjs --report reports/m9-full-disk-index/local_search_probe_after_index_100.json --timeout-ms 180000
```

Raw JSON audit files are intentionally gitignored because they contain local paths and extracted local document/image text.
