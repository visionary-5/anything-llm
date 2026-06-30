# M3-lite Visual Index Card Report

Date: 2026-06-30

## Scope

This is a small demo-oriented step after M2. It does not change the chat UI, LanceDB schema, or query API. It improves the image ingest text that gets embedded.

M1 added local VLM descriptions. M3-lite makes those descriptions more retrieval-friendly by asking the VLM for a typed search index card and caching the result locally.

## What Changed

Image enrichment now asks the local VLM for fields like:

- `SEARCH_SUMMARY`
- `VISIBLE_TEXT`
- `OBJECTS`
- `SCENE`
- `COLORS_AND_ATTRIBUTES`
- `RELATIONSHIPS`
- `DOCUMENT_TYPE`
- `SEARCH_PHRASES`

That turns an image from one free-form caption into a compact local search card. The downstream AnythingLLM path remains the same: OCR text + VLM text are combined, chunked, embedded, stored in LanceDB, and optionally reranked by the local BGE service.

The enrichment module also caches VLM output by:

- image SHA-256
- VLM model name
- prompt version
- prompt text

This prevents repeated local VLM calls for the same image and prompt.

## Config

Collector env:

```bash
WICI_ENRICH_VLM_ENABLED=true
WICI_ENRICH_VLM_MODEL=qwen2.5vl:7b
WICI_ENRICH_VLM_BASE_URL=http://127.0.0.1:11434
WICI_ENRICH_VLM_INDEX_CARD_ENABLED=true
WICI_ENRICH_VLM_CACHE_ENABLED=true
WICI_ENRICH_VLM_CACHE_DIR=/absolute/path/to/wici-enrichment-cache
```

Defaults:

- VLM enrichment is enabled in this fork.
- Index-card prompt is enabled.
- Cache is enabled.
- If `WICI_ENRICH_VLM_CACHE_DIR` is unset, cache is written under the AnythingLLM storage dir as `wici-enrichment-cache`.

To return to M1-style free-form descriptions:

```bash
WICI_ENRICH_VLM_INDEX_CARD_ENABLED=false
```

To return to OCR-only behavior:

```bash
WICI_ENRICH_VLM_ENABLED=false
```

## Demo Value

This makes the local demo easier to explain:

- Original AnythingLLM: image -> OCR only -> pure visual content is invisible.
- M1: image -> OCR + local VLM caption -> pure visual content becomes searchable.
- M2: vector candidates -> local BGE rerank -> better top-1 ordering.
- M3-lite: image -> typed local visual memory card -> richer searches like object, color, relationship, screenshot/document type, and visible text.

Good demo queries:

- `black cat`
- `camera next to phone`
- `red stamp receipt`
- `screenshot with browser`
- `team lunch`

## Smoke Evaluation

I ran a small real-ingest smoke test through the live AnythingLLM API and collector:

```bash
python3 tools/anythingllm_m0/run_true_ingest_baseline.py \
  --report-dir reports/m3-lite \
  --output-prefix m3_lite_smoke_eval \
  --run-label "M3-lite Visual Index Card Smoke Eval" \
  --ingest-path-note "real AnythingLLM upload API and collector; image files go through OCR plus local VLM visual search index card enrichment with local cache." \
  --api-key-name m3-lite-smoke \
  --workspace-name "M3-lite Visual Index Card Smoke" \
  --limit-items 10 \
  --limit-queries 3
```

Result:

| split | queries | R@1 | R@3 | R@5 | MRR | query_s | rerank_s |
|---|---:|---:|---:|---:|---:|---:|---:|
| pure_visual | 3 | 0.667 | 1.000 | 1.000 | 0.778 | 0.178 | 0.132 |

Query details:

- `q01_black_cat_sink`: rank 1.
- `q02_black_cat_grass`: rank 1.
- `q03_camera_next_to_phone`: rank 3.

The run created 10 local VLM cache entries for 10 uploaded images.

Example indexed content for the black-cat image:

```text
# WICI Visual Search Index Card
SEARCH_SUMMARY: A black cat with striking yellow eyes sits on a bathroom countertop next to a faucet and various bottles.
VISIBLE_TEXT: none
OBJECTS: black cat, faucet, bottles, countertop
SCENE: bathroom
COLORS_AND_ATTRIBUTES: black fur, yellow eyes, silver faucet, pink bottle, beige countertop
RELATIONSHIPS: cat sitting beside faucet and bottles on countertop
DOCUMENT_TYPE: photo
SEARCH_PHRASES: "black cat in bathroom", "cat with yellow eyes", "bathroom scene with cat"
```

Full output:

- [m3_lite_smoke_eval.md](m3_lite_smoke_eval.md)
- [m3_lite_smoke_eval.json](m3_lite_smoke_eval.json)

## Privacy

Image bytes are sent only to the configured local Ollama endpoint, default `http://127.0.0.1:11434`. The cache is local filesystem state. No cloud key is required.

## Relation To Full M3

This is not the full storage/schema milestone. Full M3 should still add parent source records, child representation rows, thumbnails, source handles, perceptual hash dedup, and storage metrics.

M3-lite is a low-risk bridge: it improves the current text-only AnythingLLM storage path while pointing toward typed multi-representation indexing.
