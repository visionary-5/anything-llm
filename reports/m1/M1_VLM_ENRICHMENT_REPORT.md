# M1 VLM Enrichment Report

Date: 2026-06-30

## Scope

M1 changes image ingestion from OCR-only to local VLM description plus OCR text. Retrieval, vector search, embedding provider, and rerank logic were not changed.

Images remain local: the VLM call goes to Ollama at `http://127.0.0.1:11434/api/chat` with model `qwen2.5vl:7b`. No cloud key is used and uploaded images are not sent off-machine.

## Implementation

Code paths changed:

- `collector/processSingleFile/convert/asImage.js`: image uploads now run Tesseract OCR and local VLM description, then write the combined text to the existing document/chunk/embed pipeline.
- `collector/utils/VLMImageDescription/index.js`: small module for env-gated Ollama vision calls, image resize to max 1024px, prompt, fallback, and text merge.
- `collector/utils/OCRLoader/index.js`: scanned-PDF OCR fallback now enriches rendered page images with the same VLM description path.
- `collector/.env.example`: documents `WICI_ENRICH_VLM_*` knobs.

Config:

- `WICI_ENRICH_VLM_ENABLED`: default enabled; set `false`, `0`, `off`, `no`, or `disabled` to fall back to OCR-only.
- `WICI_ENRICH_VLM_MODEL`: default `qwen2.5vl:7b`.
- `WICI_ENRICH_VLM_BASE_URL`: default `http://127.0.0.1:11434`.

VLM input is resized with `sharp` to fit within 1024px and encoded as JPEG quality 85. The stored content puts `# Visual Description` before `# OCR Text`, which avoids long OCR noise burying useful visual semantics.

Failure behavior: if VLM fails or returns empty text, ingestion continues with OCR text only. If both OCR and VLM are empty, the existing empty-content behavior remains.

## UI Evidence

Same user-facing query:

`Find the image of a black cat sitting in a bathroom sink.`

| M0 before | M1 after |
|---|---|
| [ui_black_cat_miss.png](../m0/ui_black_cat_miss.png) | [ui_black_cat_hit_final.png](ui_black_cat_hit_final.png) |

M0 returned no relevant information. M1 returns a hit for `CONTEXT 0 (coco_284623)`, sourced from the VLM description of the black cat bathroom image.

## Quant Baseline

Both runs used the same corpus and query set:

- Corpus: `../data/anythingllm-multimodal-corpus/`
- 216 files uploaded through `/api/v1/document/upload`
- 28 queries through `/api/v1/workspace/:slug/vector-search`
- Query topN: 20; reported R@1/R@3/R@5 and MRR

| split | queries | M0 R@1 | M0 R@3 | M0 R@5 | M0 MRR | M1 R@1 | M1 R@3 | M1 R@5 | M1 MRR |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| all | 28 | 0.464 | 0.536 | 0.536 | 0.513 | 0.571 | 0.786 | 0.857 | 0.703 |
| pure_visual | 13 | 0.077 | 0.154 | 0.154 | 0.138 | 0.462 | 0.615 | 0.769 | 0.585 |
| text_or_ocr | 15 | 0.800 | 0.867 | 0.867 | 0.838 | 0.667 | 0.933 | 0.933 | 0.806 |

Result: pure_visual R@5 improved from `0.154` to `0.769` and miss@5 fell from 11 to 3. Text/OCR R@5 improved from `0.867` to `0.933`; R@1 shifted down on a few text/OCR queries because visual descriptions introduce more semantically close image chunks.

Full outputs:

- M0 baseline: [m0_true_ingest_baseline.md](../m0/m0_true_ingest_baseline.md)
- M1 baseline: [m1_vlm_true_ingest_baseline.md](m1_vlm_true_ingest_baseline.md)
- M1 full JSON: [m1_vlm_true_ingest_baseline.json](m1_vlm_true_ingest_baseline.json)

Residual pure-visual misses are mostly red-stamp/receipt layout queries. The target receipt/form descriptions exist in the enriched text, but still rank below visually similar receipt/form chunks. That is a ranking problem for M2/rerank, not a VLM-ingest miss.

## Re-run

Start the fork with Node 22:

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
```

Collector local env:

```bash
WICI_ENRICH_VLM_ENABLED=true
WICI_ENRICH_VLM_MODEL=qwen2.5vl:7b
WICI_ENRICH_VLM_BASE_URL=http://127.0.0.1:11434
```

Run services in separate shells:

```bash
cd /Users/saprk/wici-visionary-5/anything-llm/collector
PATH=/opt/homebrew/opt/node@22/bin:$PATH yarn dev

cd /Users/saprk/wici-visionary-5/anything-llm/server
PATH=/opt/homebrew/opt/node@22/bin:$PATH yarn dev

cd /Users/saprk/wici-visionary-5/anything-llm/frontend
PATH=/opt/homebrew/opt/node@22/bin:$PATH yarn dev
```

Run M1 evaluation:

```bash
cd /Users/saprk/wici-visionary-5/anything-llm
python3 tools/anythingllm_m0/run_true_ingest_baseline.py \
  --workspace-name "M1 VLM Enriched Baseline VLM First" \
  --report-dir reports/m1 \
  --output-prefix m1_vlm_true_ingest_baseline \
  --run-label "M1 AnythingLLM OCR + Local VLM True-Ingest Baseline" \
  --ingest-path-note "real AnythingLLM upload API and collector; image files embed local Ollama VLM description plus Tesseract OCR text." \
  --api-key-name m1-baseline
```

## Verification

- `collector`: `yarn lint:check`
- Eval harness: `python3 -m py_compile tools/anythingllm_m0/run_true_ingest_baseline.py`
- Full M1 eval: 216/216 uploads succeeded.
- UI evidence: final M1 workspace shows black-cat query hitting `coco_284623`.
