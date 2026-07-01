# M8 Local Query Planner Report

Date: 2026-07-01

Scope: replace brittle query-term hacks with a local small-model planner that turns a fuzzy user request into a structured local-search plan.

## What Changed

- Added a local Ollama query planner at `server/utils/wiciLocalQueryPlanner/`.
- Default planner model: `qwen3.5:4b` through `http://127.0.0.1:11434`.
- The planner returns JSON only: intent, search scope, file types, positive concepts, negative concepts, visual tags, document hints, rewritten queries, and answer guidance.
- Search/index code now consumes planner terms instead of maintaining a document-specific keyword expansion table.
- Path capability questions such as `你可以索引别的路径吗` bypass RAG and answer from product capability, so the model no longer says it cannot index other paths.
- PDF ingest now adds an optional macOS QuickLook preview image description before text chunks. This lets visually sparse PDFs such as a stamped page carry `has_stamp`, `red_stamp`, `seal`, `blank_page`, and similar tags into the index.

## Why This Is Different From the Earlier Hack

The previous routing layer still had hand-written expansions for known paper topics. That helped the three-paper demo but would not generalize to full-disk search.

The new flow is:

1. User asks a fuzzy local question.
2. Local small model plans the search.
3. On-demand local source discovery uses the planned scope and file types.
4. Vector search and exact lexical evidence use the planned concepts/tags.
5. The final prompt gets bounded, source-separated context.

Rules remain only as fallback/sanitization, for example protecting `path_capability_question` and recognizing obvious `saprk/home/full disk` scope hints.

## Planner Smoke

Direct planner calls on the local dev machine:

| Query | Planner Result |
| --- | --- |
| `帮我找那个盖了章的文件` | `visual_file_search`, scope `documents`, file types `pdf,image`, tags `has_stamp, seal`, concepts `stamped document, official seal, red stamp` |
| `你可以索引别的路径吗` | `path_capability_question`, no local search |
| `saprk目录下有个两个女生的照片，请问这个照片叫什么名字` | `image_search`, scope `user_home`, file type `image`, tags `photo_people, two_people` |
| `我之前上传或索引过一张黑猫图片，帮我找出来。` | `image_search`, scope `pictures`, file type `image`, tag `black_cat` |
| `我本地那篇讲按问题难度选策略的 RAG 论文，核心想法是什么？` | `document_qa`, scope `documents`, file type `pdf`, concepts `Adaptive-RAG, query complexity, strategy selection` |
| `我下载的那篇视觉版 RAG 论文，为什么说传统 TextRAG 会丢信息？` | `document_qa`, scope `documents`, file type `pdf`, concepts `Visual-RAG, TextRAG, information loss, OCR limitations` |

Observed planner latency from `tools/wici_query_planner_smoke.cjs`: `6.691s` total for six direct calls on the local Mac with `qwen3.5:4b` (`856-1415ms` per query in this run). After this smoke run, the few-shot examples were generalized to avoid hard-coding the current demo papers/user path; static checks passed, but the sandbox approval system blocked a second live Ollama run.

## Stamped File Validation

Current validation target:

- `/Users/saprk/Documents/a.pdf`: blank control file.
- `/Users/saprk/Documents/b.pdf`: stamped/sealed document.

Indexed `b.pdf` now contains:

```text
# WICI PDF Visual Preview
SEARCH_SUMMARY: A document with a red seal and text indicating dimensions.
VISIBLE_TEXT: 北京市福喜印务学校 通过 尺寸：40*40
COLORS_AND_ATTRIBUTES: white background, red seal, black text...
VISUAL_TAGS: has_stamp, red_stamp, seal, blank_page, mostly_blank
```

Offline ranking using the planner output for `帮我找那个盖了章的文件`:

| Rank | File | Score | Hits |
| ---: | --- | ---: | --- |
| 1 | `/Users/saprk/Documents/b.pdf` | 66 | `red stamp`, `has_stamp`, `seal` |
| 2 | `/Users/saprk/Downloads/sign/1.1st resolution.pdf` | 12 | `seal` |
| 3 | `/Users/saprk/Downloads/sign/4.Share Certificate(s).pdf` | 12 | `seal` |

This proves the index can now distinguish the stamped control file from generic documents that merely contain the word `seal`.

## Honest Boundary

- I verified the core planner/index/ranking chain locally from server modules and persisted index state.
- API/UI validation for the stamped-file query still needs one manual browser/API run on the dev machine. The sandbox blocked the localhost API call even though the server was listening on `3101`.
- `a.pdf` was not present in the persisted local-source state during this run, while `b.pdf` was present and enriched. A blank PDF can still be skipped if the collector returns no usable text/visual preview. For a strict A/B acceptance test, blank-page PDFs should be retained with a minimal `blank_page/mostly_blank` visual record instead of being discarded.
- PDF preview enrichment uses macOS QuickLook and currently captures a preview image, typically the first page. Multi-page visual figure/table extraction still needs a proper page-image pipeline with page coordinates.

## Config

Server:

```bash
WICI_QUERY_PLANNER_ENABLED=true
WICI_QUERY_PLANNER_MODEL=qwen3.5:4b
WICI_QUERY_PLANNER_BASE_URL=http://127.0.0.1:11434
```

Collector:

```bash
WICI_ENRICH_PDF_PREVIEW_VLM_ENABLED=true
WICI_PDF_PREVIEW_QLMANAGE_PATH=/usr/bin/qlmanage
WICI_PDF_PREVIEW_SIZE=1400
WICI_PDF_PREVIEW_TIMEOUT_MS=30000
```

## Next Tests

1. Re-index `~/Documents` with force enabled and limit at least 5.
2. Ask: `帮我找那个盖了章的文件`.
3. Expected source: `/Users/saprk/Documents/b.pdf`.
4. Ask: `我之前上传或索引过一张黑猫图片，帮我找出来。`.
5. Expected behavior: planner scopes to images; final success depends on whether that image is already indexed with VLM tags.
6. Ask: `saprk目录下有个两个女生的照片，请问这个照片叫什么名字`.
7. Expected behavior: planner scopes to `user_home` image search; full success depends on whether the matching photo has been indexed/enriched.

Smoke artifacts from the live run:

```bash
reports/m8-local-query-planner/artifacts/planner_smoke.json
reports/m8-local-query-planner/artifacts/stamped_file_offline_rank.json
```
