# M6 Local Memory Usefulness Report

## Goal

Move from "the UI can index local folders" to "the agent can use local indexed data like local web search."

The expected user behavior is not:

```text
Search this exact folder or this exact file.
```

It is:

```text
Find the PDF about X.
Who is listed in that company register?
Find the image where a phone is next to a camera.
```

The user should not need to tell the agent where the file lives.

## Cleanup

Removed disposable evaluation/smoke workspaces through the supported AnythingLLM API:

- `m0-before-baseline`
- `m0-before-ui-clean`
- `m0-api-baseline-20260630-123419`
- `m1-ui-black-cat-hit`
- `m1-vlm-enriched-baseline`
- `m1-vlm-enriched-baseline-vlm-first`
- `m3-lite-visual-index-card-smoke`
- `wici-local-source-ui-smoke`

Remaining workspaces:

- `wici-local-folder-memory`
- `wici-local-dir-demo`

## Full-Disk Scan Defaults

The local source scanner now skips hidden/cache/build/runtime folders by default, including examples such as:

- `.cache`
- `.npm`
- `.pnpm-store`
- `.turbo`
- `.next`
- `node_modules`
- `site-packages`
- `dist`
- `build`
- `coverage`
- `DerivedData`
- `Library`

The scanner also ranks candidates so full-disk indexing starts with higher-value user files:

1. PDF
2. Office files
3. Images
4. Markdown/text
5. CSV/JSON

Bounded full-disk dry run:

```json
{
  "roots": ["/"],
  "seen": 500,
  "changedOrNew": 500,
  "toIndex": 10,
  "firstCandidate": "/Users/saprk/Downloads/3.Apply for shares.pdf"
}
```

The previous `.cache/uv/.../top_level.txt` result no longer appears in the leading candidates.

## Source-Aware RAG Context

The LLM context now includes local search metadata before each retrieved chunk:

```text
<document_metadata>
{
  "title": "...",
  "source_path": "file:///...",
  "chunk_source": "file:///...",
  "document_source": "WICI local folder source",
  "score": ...
}
</document_metadata>

chunk text...
```

The system prompt also tells the model to treat local document context as indexed local search results and to include file title/path when answering find-style questions.

This is important because the user should be able to ask natural questions without specifying a path.

## Verification

Workspace tuned for local search:

```text
workspace: wici-local-folder-memory
chatMode: query
topN: 12
similarityThreshold: 0
```

Bounded full-disk ingest:

```json
{
  "attempted": 20,
  "ok": 20,
  "failed": 0,
  "elapsedMs": 25648
}
```

Natural query with no path:

```text
WiCi Technologies Holding Limited 的 register of directors 里 director 是谁？请告诉我你找到的文件名和本地路径。
```

Answer found:

```text
Director: Zili Meng
File: 8.@reg of dir.pdf
Path: file:///Users/saprk/Downloads/sign/8.@reg of dir.pdf
```

Top sources included:

```text
8.@reg of dir.pdf | file:///Users/saprk/Downloads/sign/8.@reg of dir.pdf
5.reg of beneficial owner-WiCi Technologies Holding Limited-20260601.pdf
2.Consent form.pdf
```

## What This Proves

The fork now has the first usable local-memory loop:

```text
local disk -> filtered scan -> OCR/VLM enrichment -> embeddings/rerank -> source-aware answer
```

The UI is just one control surface. The product value is that the agent can answer against indexed local data without the user telling it where to look.

## Next Work

- Add a managed background watcher for selected roots.
- Add app-level sources: Photos, Notes, Mail, browser history, and `wici-retina` captures.
- Add delete/update reconciliation when local files disappear or move.
- Add source previews/thumbnails in answers for images.
- Add a planner layer that chooses filename/metadata/vector/VLM/OCR search depending on query intent.
