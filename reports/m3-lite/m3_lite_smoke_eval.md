# M3-lite Visual Index Card Smoke Eval

## Settings

- API base: `http://localhost:3101/api`
- Workspace: `m3-lite-visual-index-card-smoke`
- Corpus items uploaded: 10/10
- Query topN: 20; reported recall: R@1/R@3/R@5; MRR uses first relevant rank within top20.
- Ingest path: real AnythingLLM upload API and collector; image files go through OCR plus local VLM visual search index card enrichment with local cache.

## Summary

| split | queries | R@1 | R@3 | R@5 | MRR | miss@5 | query_s | rerank_s |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| all | 3 | 0.667 | 1.000 | 1.000 | 0.778 | 0 | 0.178 | 0.132 |
| pure_visual | 3 | 0.667 | 1.000 | 1.000 | 0.778 | 0 | 0.178 | 0.132 |
| text_or_ocr | 0 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0.000 | 0.000 |

## By Category

| category | queries | R@1 | R@3 | R@5 | MRR |
|---|---:|---:|---:|---:|---:|
| pure_visual_photo | 3 | 0.667 | 1.000 | 1.000 | 0.778 |

## Query Rows

| id | pure_visual | rank | query_s | rerank_s | top5 |
|---|---:|---:|---:|---:|---|
| q01_black_cat_sink | true | 1 | 0.266 | 0.228 | coco_284623, coco_304560, coco_423506, coco_110449, coco_221693 |
| q02_black_cat_grass | true | 1 | 0.148 | 0.098 | coco_304560, coco_221693, coco_284623, coco_446207, coco_259597 |
| q03_camera_next_to_phone | true | 3 | 0.119 | 0.069 | coco_259597, coco_110449, coco_446207, coco_423506, coco_324715 |
