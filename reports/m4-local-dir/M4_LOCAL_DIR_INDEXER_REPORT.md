# M4 Local Directory Indexer Report

Date: 2026-06-30

## Scope

This milestone makes the demo feel less like manual upload RAG and more like local memory.

It adds a small local indexer tool that scans files/folders and uploads changed files into an AnythingLLM workspace through the real API:

```text
local directory
-> AnythingLLM /api/v1/document/upload
-> collector
-> OCR + local VLM visual index card
-> embed
-> LanceDB
-> local BGE rerank at query time
```

No new cloud service is involved. Images still go only to local Ollama by default.

## Why This Matters

M0-M3 proved that uploaded images can become searchable. The product gap was that users still had to manually upload files.

This tool lets the user say: "index this folder", then ask the workspace:

```text
帮我找相机旁边放着手机的图片
帮我找黑猫照片
帮我找有红色印章的收据
帮我找浏览器截图
```

They do not need to know the filename or path after the folder has been indexed.

## Implementation

New tool:

- [index_local_dirs.py](../../tools/local_dir_indexer/index_local_dirs.py)

Features:

- Recursively scans one or more local roots.
- Supports common image, document, PDF, spreadsheet, and text extensions.
- Uses AnythingLLM's public dev API instead of importing server internals.
- Adds files to a workspace during upload.
- Tracks `path -> size:mtime` in a local manifest so unchanged files are skipped.
- Supports one-shot mode and polling watch mode.
- Stores runtime state under `server/storage/wici-local-dir-indexer/`, ignored by git.

`wici-retina` connection:

- `wici-retina` is the local visual tool layer: capture/perceive/transform locally and return compact handles/text.
- This indexer applies the same principle to RAG: local files become compact searchable representations before an agent asks questions.
- This milestone does not modify `wici-retina`; it borrows the architectural principle.

## Usage

Start AnythingLLM server, collector, frontend, Ollama, and optional rerank service. Then run:

```bash
cd /Users/saprk/wici-visionary-5/anything-llm

python3 tools/local_dir_indexer/index_local_dirs.py \
  --workspace-name "WICI Local Folder Memory" \
  --report reports/m4-local-dir/local_dir_index_report.json \
  /path/to/folder
```

Or use env:

```bash
WICI_LOCAL_INDEX_DIRS="/Users/saprk/Pictures,/Users/saprk/Downloads" \
python3 tools/local_dir_indexer/index_local_dirs.py \
  --workspace-name "WICI Local Folder Memory"
```

Watch/poll mode:

```bash
python3 tools/local_dir_indexer/index_local_dirs.py \
  --workspace-slug wici-local-folder-memory \
  --watch \
  --interval 60 \
  /path/to/folder
```

Dry run:

```bash
python3 tools/local_dir_indexer/index_local_dirs.py \
  --dry-run \
  /path/to/folder
```

Smoke query after indexing:

```bash
python3 tools/local_dir_indexer/index_local_dirs.py \
  --workspace-slug wici-local-folder-memory \
  --limit 0 \
  --smoke-query "帮我找相机旁边放着手机的图片" \
  /path/to/folder
```

## Verification

I created a local demo folder outside the repo:

```text
/tmp/wici-local-dir-demo/
  black-cat-sink.jpg
  camera-phone.jpg
  red-stamp-receipt.png
```

Then indexed it:

```bash
python3 tools/local_dir_indexer/index_local_dirs.py \
  --workspace-name "WICI Local Dir Demo" \
  --state-path server/storage/wici-local-dir-indexer/demo-manifest.json \
  --report reports/m4-local-dir/local_dir_demo_index_report.json \
  /tmp/wici-local-dir-demo
```

Result:

| seen | attempted | ok | failed | elapsed_s |
|---:|---:|---:|---:|---:|
| 3 | 3 | 3 | 0 | 5.088 |

Then I ran query-only smoke checks against the indexed workspace:

```bash
python3 tools/local_dir_indexer/index_local_dirs.py \
  --workspace-slug wici-local-dir-demo \
  --state-path server/storage/wici-local-dir-indexer/demo-manifest.json \
  --report reports/m4-local-dir/local_dir_demo_query_report.json \
  --smoke-query "帮我找相机旁边放着手机的图片" \
  --smoke-query "帮我找黑猫照片" \
  --smoke-query "帮我找有红色印章的收据" \
  --limit 0 \
  /tmp/wici-local-dir-demo
```

Results:

| query | top result |
|---|---|
| 帮我找相机旁边放着手机的图片 | `camera-phone.jpg` |
| 帮我找黑猫照片 | `black-cat-sink.jpg` |
| 帮我找有红色印章的收据 | `red-stamp-receipt.png` |

Full machine-readable reports:

- [local_dir_demo_index_report.json](local_dir_demo_index_report.json)
- [local_dir_demo_query_report.json](local_dir_demo_query_report.json)

## Notes

This is intentionally a sidecar tool rather than a server daemon. That keeps the first version low-risk and makes the data-source idea easy to test. A later version can move it into a managed background worker, add a UI for authorized folders, and connect to `@wici/sdk` / `wici-one` permission grants.
