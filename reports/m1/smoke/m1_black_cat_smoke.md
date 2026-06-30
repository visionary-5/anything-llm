# M1 Black Cat Smoke

## Settings

- API base: `http://localhost:3101/api`
- Workspace: `m1-ui-black-cat-hit`
- Corpus items uploaded: 5/5
- Query topN: 20; reported recall: R@1/R@3/R@5; MRR uses first relevant rank within top20.
- Ingest path: real AnythingLLM upload API and collector; image files go through Tesseract OCR plus local Ollama VLM description.

## Summary

| split | queries | R@1 | R@3 | R@5 | MRR | miss@5 |
|---|---:|---:|---:|---:|---:|---:|
| all | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0 |
| pure_visual | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0 |
| text_or_ocr | 0 | 0.000 | 0.000 | 0.000 | 0.000 | 0 |

## By Category

| category | queries | R@1 | R@3 | R@5 | MRR |
|---|---:|---:|---:|---:|---:|
| pure_visual_photo | 1 | 1.000 | 1.000 | 1.000 | 1.000 |

## Query Rows

| id | pure_visual | rank | top5 |
|---|---:|---:|---|
| q01_black_cat_sink | true | 1 | coco_284623, coco_110449, coco_135410, coco_259597, coco_221693 |
