# M6 Follow-Up: Newly Downloaded PDF Discovery

## User Case

The user asked about a local VisRAG paper whose filename starts with `2410` without telling the agent where it was stored:

```text
VisRAG-Ret 如何从 VLM 的最后一层隐藏状态得到最终 embedding?
第 i 个 token 的权重具体如何计算?
为什么要这样加权?
```

The file existed at:

```text
/Users/saprk/Documents/2410.10594v2.pdf
```

Before this follow-up, the workspace returned only demo image contexts because the PDF was not indexed.

## Fixes

- Full-disk and home scans now prepend user content roots before broad traversal:
  - `~/Documents`
  - `~/Downloads`
  - `~/Desktop`
  - `~/Pictures`
  - `~/Movies`
  - `~/Music`
- Candidate ranking now prefers recently modified files within each file type, so a newly downloaded PDF is surfaced before old material.
- The Local folders UI now defaults to user file roots instead of only `~/Pictures`.
- Added a `User files` preset for the common local-memory scan.
- Server-to-collector calls can now use `COLLECTOR_BASE_URL`; development is configured for `http://127.0.0.1:8899`.
- Removed an incompatible per-request `undici.Agent` from document processing. On Node 26 it caused `fetch failed` with `UND_ERR_INVALID_ARG`; the server already applies a global 600s fetch timeout patch.
- Added a response sanitizer for non-streamed API paths so `<think>` blocks are not persisted or returned as final answers.

## Verification

All Mac dry run, bounded to 500 scanned files:

```json
{
  "roots": [
    "/Users/saprk/Documents",
    "/Users/saprk/Downloads",
    "/Users/saprk/Desktop",
    "/Users/saprk/Pictures",
    "/Users/saprk/Movies",
    "/Users/saprk/Music",
    "/"
  ],
  "firstCandidate": "/Users/saprk/Documents/2410.10594v2.pdf"
}
```

Index job:

```json
{
  "path": "/Users/saprk/Documents/2410.10594v2.pdf",
  "ok": true,
  "wordCount": 11856,
  "chunks": 11,
  "source": "file:///Users/saprk/Documents/2410.10594v2.pdf"
}
```

The workspace now has:

```text
wici-local-folder-memory: 21 documents
wici-local-dir-demo: 3 documents
```

## Answer Grounded In The Indexed PDF

The relevant text is in `2410.10594v2.pdf`, section `3.2.1 Retrieval`.

VisRAG-Ret encodes the query and page separately with a VLM, producing a sequence of last-layer hidden states. It then applies position-weighted mean pooling:

```text
v = sum_{i=1}^{S} w_i h_i
```

where `h_i` is the i-th hidden state and `S` is the sequence length.

The i-th token weight is:

```text
w_i = i / sum_{j=1}^{S} j
```

Because the VLM is generative and uses causal attention, later tokens have seen more prior context. The paper therefore gives later tokens larger weights, making the pooled embedding emphasize hidden states that contain more accumulated context.

## Remaining Gap

The system now finds and indexes the newly downloaded PDF. However, the generated answer can still miss fine-grained formulas when the retrieved chunk is long and the local chat model focuses on adjacent experiment/result text.

Next RAG improvement should target document-internal precision:

- smaller semantic chunks for long PDFs,
- keyword/BM25 + vector hybrid retrieval inside the matched document,
- section/title-aware chunk metadata,
- optional rerank at chunk level after document match,
- non-thinking default chat model or streaming `<think>` filtering for UI polish.
