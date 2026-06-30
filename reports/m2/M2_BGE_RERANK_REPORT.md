# M2 BGE Rerank Report

Date: 2026-06-30

## Scope

M2 adds server-side cross-encoder reranking after LanceDB vector recall. It reuses the M1 OCR + local VLM enriched workspace and does not change ingestion, embedding, or UI code.

Rerank is fully local: the server calls `http://127.0.0.1:8892/rerank`, backed by `BAAI/bge-reranker-base` loaded from the existing local HF cache at `../data/anythingllm-scale-corpus/models/hf_cache`. No cloud key is used.

## Implementation

New local service:

- [serve_bge_rerank.py](../../tools/rerank_service/serve_bge_rerank.py): FastAPI service wrapping the existing BGE cross-encoder scoring logic.
- [requirements.txt](../../tools/rerank_service/requirements.txt): Python runtime deps for the local service.

Server-side rerank path:

- [wiciLocalBge](../../server/utils/EmbeddingRerankers/wiciLocalBge/index.js): small env-gated client for `/rerank`.
- [lance/index.js](../../server/utils/vectorDbProviders/lance/index.js): expands dense candidate pool to `WICI_RERANK_POOL`, calls local BGE service, then trims to requested topN.
- [workspace API](../../server/endpoints/api/workspace/index.js): includes `rerankLatencyMs` in `/api/v1/workspace/:slug/vector-search` responses for measurement.

Config:

- `WICI_RERANK_ENABLED`: default enabled in this fork; set `false`, `0`, `off`, `no`, or `disabled` to use dense order only.
- `WICI_RERANK_URL`: default `http://127.0.0.1:8892/rerank`.
- `WICI_RERANK_POOL`: default `50`.

## Before/After

All rows use the same 216-item corpus and 28-query set. M2 reuses the M1 enriched workspace and measures only server-side rerank on retrieval.

| split | M0 R@1 | M0 R@5 | M1 R@1 | M1 R@5 | M2 R@1 | M2 R@5 | M2 MRR | M2 rerank_s/query |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| all | 0.464 | 0.536 | 0.571 | 0.857 | 0.679 | 0.857 | 0.757 | 0.568 |
| pure_visual | 0.077 | 0.154 | 0.462 | 0.769 | 0.538 | 0.769 | 0.627 | 0.590 |
| text_or_ocr | 0.800 | 0.867 | 0.667 | 0.933 | 0.800 | 0.933 | 0.870 | 0.549 |

Key result: `text_or_ocr R@1` recovered from `0.667` to `0.800`, and `pure_visual R@1` improved from `0.462` to `0.538`. R@5 stayed flat, which is expected because rerank changes order inside the retrieved candidate pool.

Full output:

- [m2_bge_rerank_eval.md](m2_bge_rerank_eval.md)
- [m2_bge_rerank_eval.json](m2_bge_rerank_eval.json)

## Query Movement

Important wins:

- `q06_rocket_clouds_page`: M1 rank 5 -> M2 rank 1.
- `q08_airtable_collaboration`: M1 rank 2 -> M2 rank 1.
- `q11_red_stamp_receipt`: M1 rank 12 -> M2 rank 1.
- `q15_floorp_browser`: M1 rank 2 -> M2 rank 1.
- `q28_team_lunch`: M1 rank 2 -> M2 rank 1.

Regressions to watch:

- `q03_camera_next_to_phone`: M1 rank 4 -> M2 rank 11.
- `q05_two_men_ties`: M1 rank 1 -> M2 rank 3.
- `q07_bitly_cartoon`: M1 rank 1 -> M2 rank 3.
- `q16_receipt_total`: M1 rank 12 -> M2 rank 19.
- `q24_laptop_and_keyboard`: M1 rank 2 -> M2 rank 4.

Overall R@1 improves, but BGE sometimes prefers text-heavy or semantically generic visual candidates over the exact image match. A later milestone can tune query/document formatting or use a domain-specific reranker for visual descriptions.

## UI Evidence

Black-cat query still hits the correct image after rerank:

- [ui_black_cat_m2_rerank_hit.png](ui_black_cat_m2_rerank_hit.png)

The first source remains `coco_284623`.

## Re-run

Start the local rerank service:

```bash
cd /Users/saprk/wici-visionary-5/anything-llm
.m2-rerank-venv/bin/python tools/rerank_service/serve_bge_rerank.py \
  --host 127.0.0.1 \
  --port 8892 \
  --cache-dir ../data/anythingllm-scale-corpus/models/hf_cache \
  --batch-size 16 \
  --max-length 512
```

Start server with:

```bash
WICI_RERANK_ENABLED=true
WICI_RERANK_URL=http://127.0.0.1:8892/rerank
WICI_RERANK_POOL=50
```

Run M2 evaluation against the M1 enriched workspace:

```bash
cd /Users/saprk/wici-visionary-5/anything-llm
python3 tools/anythingllm_m0/run_true_ingest_baseline.py \
  --skip-upload \
  --workspace-slug m1-vlm-enriched-baseline-vlm-first \
  --report-dir reports/m2 \
  --output-prefix m2_bge_rerank_eval \
  --run-label "M2 Server-Side BGE Rerank Eval" \
  --ingest-path-note "reuse M1 OCR + local VLM enriched workspace; server-side LanceDB candidate pool is reranked by local BGE service." \
  --api-key-name m2-baseline
```

## Verification

- `tools/rerank_service/serve_bge_rerank.py`: `py_compile`
- `tools/anythingllm_m0/run_true_ingest_baseline.py`: `py_compile`
- M2-changed server files: eslint passed.
- Full server lint still has unrelated pre-existing prettier errors in `server/endpoints/workspaces.js` and `server/utils/agents/aibitat/plugins/create-files/pdf/create-pdf-file.js`.
- BGE model cache was already present; no model weights were downloaded for M2.
