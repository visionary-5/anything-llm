# WICI RAG Kernel Architecture Note

Date: 2026-06-30

This note is for planning, not a code change. It summarizes what M0/M1/M2 proved in the AnythingLLM fork, what the local WICI repos already provide, and what the next architecture should become if the goal is a WICI Box data/memory layer rather than a one-off AnythingLLM tweak.

## 1. Plain-English State

We are not trying to make vector search faster. The experiments already showed that retrieval over personal-scale data is cheap. The product gap is earlier and later than search:

- Earlier: raw pixels, PDFs, screenshots, receipts, charts, UI captures, and photos need to be turned into useful searchable representations.
- Later: once we have many useful representations, the system needs to choose and rank the right evidence, not merely return the nearest embedding.

AnythingLLM is a good shell: polished UI, upload flow, workspaces, existing LanceDB path. But the long-term product should be a WICI RAG kernel that AnythingLLM, `@wici/sdk`, and `wici-one` can all call.

## 2. What M0/M1/M2 Already Proved

| milestone | change | result |
|---|---|---|
| M0 | Ran the fork as-is and measured real Tesseract-only ingestion. | Pure-visual content mostly missed. `pure_visual R@5 = 0.154`, `R@1 = 0.077`. Black-cat query missed. |
| M1 | Added local VLM enrichment at image ingest: OCR + VLM description, then normal embedding. | Black-cat query hit. `pure_visual R@5 = 0.769`, `R@1 = 0.462`. Text/OCR R@5 held at `0.933`, but R@1 dropped because candidate sets got denser. |
| M2 | Added local BGE cross-encoder rerank after LanceDB recall. | `text_or_ocr R@1` recovered `0.667 -> 0.800`; `pure_visual R@1` improved `0.462 -> 0.538`; mean rerank latency about `0.568s/query`. |

Interpretation:

- M1 proved the central thesis: local VLM enrichment turns invisible visual content into retrievable text.
- M2 proved the second thesis: after enrichment, top-k recall is not enough; we need ranking/control over candidate evidence.
- M2 also exposed a limitation: generic text rerank sometimes demotes exact visual matches. That points toward better query/document formatting, representation typing, and eventually visual-aware reranking.

## 3. Local Repo Boundaries

### AnythingLLM fork

Current role: UI shell and compatibility path.

Relevant facts:

- Image ingestion is currently in `collector/processSingleFile/convert/asImage.js`.
- PDF ingestion is in `collector/processSingleFile/convert/asPDF/`.
- Chunking is a generic recursive text splitter around 1000 chars with small overlap.
- Vector storage/query is in `server/utils/vectorDbProviders/lance/index.js`.
- M1/M2 currently inject local VLM and local rerank directly into this fork.

Problem: the fork stores mostly a single text blob per source. That is enough for M1 but not enough for long-term WICI retrieval.

### `wici-engine-backend`

Current role: stable local/box compute contract.

Relevant facts:

- `/engine` already defines package/model/session/pipeline boundaries.
- It can route text/VLM calls through a CUDA/NVIDIA adapter backed by local Ollama.
- The existing RAG service already has the right recipe: resize image for VLM input, describe with a factual search-index prompt, embed the description, store image metadata.
- `PipelineService` can become the place where enrichment is expressed as named steps instead of hardcoded collector calls.

Architectural implication: direct calls from AnythingLLM to Ollama should be a temporary fast path. Long term, enrichment and rerank should call WICI engine services on the Box.

### `@wici/sdk`

Current role: client boundary for apps.

Relevant facts:

- It already exposes `rag`, `ragUpload`, `ragUploadFile`, `ragUploadImage`, and workspace APIs.
- It also has `/engine` helpers and asset upload/cache patterns.

Architectural implication: RAG should have a stable service contract so phone/desktop apps can index local data without knowing AnythingLLM internals.

### `wici-one`

Current role: mini-app host with permission-gated capabilities.

Relevant facts:

- Mini Apps must not see Box URLs or tokens.
- The host owns Box access and injects capabilities.

Architectural implication: personal memory/RAG should be exposed as a permission-gated capability, not as direct network access from a mini app.

## 4. Research Takeaways

The papers and docs point in the same direction:

- ColPali shows visually rich documents should sometimes be indexed as page images with multi-vector late interaction, not only OCR text. This directly matches our pure-visual miss. Source: https://arxiv.org/abs/2407.01449
- VisRAG and M3DocRAG show text-only RAG loses layout, figure, chart, and image evidence in real documents. Source: https://arxiv.org/abs/2410.10594 and https://arxiv.org/abs/2411.04952
- RAG-Anything frames multimodal documents as interconnected entities rather than isolated text chunks. That is close to what we need for screenshots, receipts, charts, and mixed PDFs. Source: https://arxiv.org/abs/2510.12323
- ColBERT explains why late interaction can improve ranking without paying full cross-encoder cost for every document. Source: https://arxiv.org/abs/2004.12832
- BGE's model card recommends using cross-encoder rerank over top-k documents returned by an embedding model. That matches M2. Source: https://huggingface.co/BAAI/bge-reranker-base
- RAPTOR argues that only retrieving short chunks loses document-level context, so hierarchical summaries are useful for long documents. Source: https://arxiv.org/abs/2401.18059
- MemGPT and Generative Agents both point to tiered long-term memory: raw observations, summaries/reflections, and dynamic retrieval into limited context. Source: https://arxiv.org/abs/2310.08560 and https://arxiv.org/abs/2304.03442
- LanceDB already supports patterns we need: vector search plus full-text hybrid search, reranking, and metadata filters. Source: https://docs.lancedb.com/search/hybrid-search and https://docs.lancedb.com/search/filtering

Takeaway: M1 is the minimum useful enrichment. The fuller architecture should be multi-representation, typed, metadata-filtered, and locally reranked.

## 5. Proposed Architecture

The target should be a WICI RAG kernel with five layers.

### 5.1 Source Layer

Purpose: know what the object is before embedding it.

Store:

- `source_id`: stable content identity, preferably SHA-256 over bytes plus source namespace.
- `source_uri`: original reference, not always a copied file.
- `source_app`: file picker, camera roll, browser, email, chat, workspace folder, mini app.
- `mime_type`, `size_bytes`, timestamps, EXIF, path, permission scope.
- `content_hash` and perceptual hash for images/screenshots.

Why this matters:

- Storage optimization starts here. The index should not duplicate full originals blindly.
- Permissions and provenance start here. `wici-one` needs this for capability safety.
- Dedup/enrichment cache starts here. Same image should not run VLM twice.

### 5.2 Enrichment Layer

Purpose: turn each source into several searchable facts.

Per image/page/screenshot:

- OCR text, preferably full-resolution OCR.
- VLM description from resized VLM input.
- visible text rewritten as normalized search text.
- detected object/action tags.
- optional structured extractor for receipts, invoices, UI screenshots, charts, tables.
- thumbnail and optional region/page coordinates.

Per document:

- raw text extraction.
- layout-aware chunks where possible.
- document summary.
- page summaries.
- entities, dates, amounts, people, organizations.

Important rule: keep enrichment outputs typed. Do not flatten everything into one anonymous blob.

Example representation rows:

| representation type | example text | query it helps |
|---|---|---|
| `ocr_text` | `Total $34.18, Trader Joe's` | exact receipt total |
| `vlm_caption` | `A black cat sitting on a wooden floor` | black cat |
| `visual_tags` | `cat, black fur, wooden floor, indoor photo` | object queries |
| `table_text` | normalized rows from a table/chart | spreadsheet/chart questions |
| `doc_summary` | page/document-level summary | broad questions |
| `metadata_text` | `created: 2026-06, source_app: camera` | time/source queries |

### 5.3 Representation Store

Purpose: store raw objects and derived representations separately.

Recommended shape:

- Object store: original file handle or content-addressed blob.
- Thumbnail store: small preview for UI and rerank/debug.
- Metadata DB: SQLite/Postgres-style relational records for source, permissions, enrichment status.
- Vector table: one row per representation, with `source_id`, `representation_id`, `representation_type`, `text`, `vector`, and filterable metadata.
- Optional FTS table/index: exact text and keywords.

This is the main storage improvement over the current fork. AnythingLLM today treats documents mostly as text chunks. WICI should treat one file as a parent object with many derived children.

### 5.4 Retrieval Planner

Purpose: do not always run the same search.

The planner classifies the query into intents:

- visual object: `black cat`, `camera next to phone`.
- OCR/exact text: `receipt total`, `invoice number`, `bitly`.
- metadata/time: `photos from last month`, `files from WeChat`.
- document semantic: `contract about renewal`.
- structured: `receipts over $50`, `charts showing revenue drop`.
- memory: `what did I decide last time`.

Then it chooses candidate sources:

- dense vector over VLM/OCR/summary.
- keyword/FTS for exact strings.
- metadata filters for time/source/type.
- optional visual/page-image retrieval later.
- structured field query for receipts/tables.

This is the piece that makes the product feel less ordinary. The user should not need to know which file to search.

### 5.5 Fusion, Rerank, and Verification

Purpose: choose the final evidence.

Pipeline:

1. Pull candidates from multiple routes.
2. Fuse by source and representation type.
3. Rerank top candidates locally.
4. Apply cheap rules: exact text match, metadata match, source diversity.
5. For hard visual cases, optionally run VLM verification on top 3 thumbnails/pages.

M2 uses one generic BGE reranker. That should remain a baseline, but the architecture should allow:

- text cross-encoder rerank for OCR/text.
- visual-aware rerank or VLM verification for image-heavy queries.
- representation-aware prompts, for example prefix candidate text with `representation_type=vlm_caption`.

## 6. What Should Live Where

| concern | temporary home | long-term home |
|---|---|---|
| AnythingLLM UI and workspace demo | AnythingLLM fork | Still useful as a demo shell |
| image OCR + VLM enrichment | AnythingLLM collector | WICI enrichment service through `/engine` or RAG service |
| rerank | AnythingLLM server calling local FastAPI | WICI Box ranking service, possibly exposed through RAG kernel |
| original/thumbnail storage | AnythingLLM storage dir | WICI content-addressed object store |
| source permissions | AnythingLLM workspace-level only | `wici-one` host capability and SDK-level scopes |
| ingestion from phone/files/apps | manual upload | `@wici/sdk` connectors and native permission grants |
| eval harness | AnythingLLM tools | shared WICI retrieval acceptance suite |

## 7. Revised Milestones

### M3: Storage and Representation Contract

Do not start with another model. Start by changing the data contract.

Deliverables:

- parent source record plus child representation records.
- content hash and perceptual hash.
- enrichment cache keyed by source hash, model, prompt version.
- separate thumbnail/original reference.
- metrics: bytes stored per item, duplicate skip rate, enrichment cache hit rate.

Expected user-visible value:

- same photo uploaded twice does not double storage or rerun VLM.
- source provenance is visible enough for debugging.

### M4: Hybrid Retrieval Planner

Deliverables:

- query intent classifier, rule-based first.
- dense + FTS + metadata candidate collection.
- candidate fusion with representation-type weights.
- eval splits beyond pure_visual/text_or_ocr: exact text, object, receipt, metadata, multi-hop.

Expected user-visible value:

- queries like `receipt total`, `from last month`, `red stamp`, and `black cat` route differently.

### M5: Structured Enrichment Packs

Deliverables:

- receipt/invoice extractor.
- chart/table summarizer.
- screenshot/UI parser.
- optional entity/date/amount extraction.

Expected user-visible value:

- not just "find the image", but answer structured questions over local artifacts.

### M6: Move Compute Behind WICI Box Contracts

Deliverables:

- AnythingLLM enrichment calls WICI engine/RAG service instead of raw Ollama/FastAPI.
- `@wici/sdk` can upload/index images and files into the same kernel.
- `wici-one` can expose memory/search as a permission-gated capability.

Expected user-visible value:

- same local memory layer is usable from the demo UI, phone apps, and mini apps.

### M7: Visual-Native Retrieval

Deliverables:

- optional ColPali/SigLIP/CLIP-style image/page embeddings.
- page-image or region-level retrieval for charts/layout-heavy PDFs.
- VLM verification on top candidates.

Expected user-visible value:

- better retrieval when text captions are insufficient or ambiguous.

## 8. Evaluation Plan

Keep the M0/M1/M2 recall harness, but add product-level metrics:

- retrieval: R@1/R@3/R@5/MRR by query type.
- rerank: latency per query and regression list.
- enrichment: seconds/item, tokens/local model calls, failure fallback rate.
- storage: original bytes, derived bytes, thumbnail bytes, vector rows/item, dedup rate.
- privacy: all enrichment/rerank endpoints are localhost or WICI Box LAN; no cloud key path.
- UX: user can ask without naming a file; UI shows source evidence with enough provenance.

The key comparisons should be:

- original AnythingLLM baseline.
- M1 local VLM enrichment.
- M2 rerank.
- future WICI kernel with multi-representation + hybrid planner.

## 9. Design Position

The current fork is no longer just "AnythingLLM plus a better OCR step." It should become the first adapter onto a WICI local-memory substrate.

Short term, keep using AnythingLLM because it demos well and gives us a real product path. Long term, avoid burying WICI-specific intelligence inside random AnythingLLM collector files. The durable asset is:

1. a local enrichment pipeline,
2. a typed multi-representation index,
3. a storage/provenance layer,
4. a retrieval planner plus rerank/verification,
5. an SDK/Box contract that other WICI surfaces can reuse.

That is the architecture that makes the RTX 5090 matter: it turns private local pixels and files into searchable memory without sending them to a cloud API.
