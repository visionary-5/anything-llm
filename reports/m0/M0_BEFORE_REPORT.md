# M0 Before Baseline Report

Date: 2026-06-30

## Scope

M0 only runs the fork, captures the current AnythingLLM/Tesseract behavior, and adds a repeatable measurement harness. No OCR, embedding, retrieval, rerank, or enrichment business logic was changed.

## Dev Environment Source

I followed the repository's own docs:

- `README.md`: development setup flow, `yarn setup`, then separate `yarn dev:server`, `yarn dev:frontend`, and `yarn dev:collector` style services.
- `BARE_METAL.md`: Node/Yarn expectations, `STORAGE_DIR`, Prisma generation/migration, and service startup notes.
- `server/.env.example`, `frontend/.env.example`, `collector/.env.example`: actual environment variables.

Local configuration used for M0:

- Frontend: `http://localhost:3000`
- Server API: `http://localhost:3101/api`
- Collector: `http://localhost:8899`
- LLM provider: local Ollama at `http://127.0.0.1:11434`
- Chat model: local Ollama model `qwen3.5:4b`
- Embedder: local Ollama model `mxbai-embed-large:latest`
- Vector DB: default LanceDB
- Runtime storage: `.m0-storage/` so it does not collide with AnythingLLM Desktop storage

The server's Prisma SQLite path is still the repository default `server/storage/anythingllm.db`; I did not change the Prisma schema for M0.

## Environment Issues Hit

- The machine's default `node` was `v26.0.0`; AnythingLLM's current dependency stack failed under it with an `undici` dispatcher error. Running the dev services with Homebrew `node@22` (`v22.22.3`) fixed it.
- AnythingLLM Desktop was already listening on `127.0.0.1:3001` and `127.0.0.1:8888`, so the fork uses `3101` and `8899`.
- The collector dev script reads `.env.development`; setup created `.env`. I added a local `collector/.env.development` with `COLLECTOR_PORT=8899`.
- The collector swallows `listen` errors, so sandbox port denial looked like a clean exit. Running dev services with permission to listen on local ports fixed this.
- Collector dependency install tried to download Puppeteer Chromium. I skipped that bundled browser with `PUPPETEER_SKIP_DOWNLOAD=true`; the image OCR path still uses the repository's normal Tesseract/collector flow.
- Frontend imported `regenerator-runtime` but did not declare it in `frontend/package.json`; I added the missing dependency so the Vite dev server can boot.

## Before UI Evidence

Clean UI workspace: `m0-before-ui-clean`

Uploaded pure-visual images through the fork's normal upload path:

- `coco_284623.jpg`: Tesseract text was only `WEE`
- `coco_446207.jpg`: OCR noise, no visual caption
- `coco_259597.jpg`: OCR noise, no visual caption

Query in UI:

`Find the image of a black cat sitting in a bathroom sink.`

Result: AnythingLLM returned no relevant information. This establishes the "before" miss with the product's real image -> Tesseract OCR -> text -> embed path.

Screenshot: [ui_black_cat_miss.png](ui_black_cat_miss.png)

## Quant Baseline

Harness: [run_true_ingest_baseline.py](../../tools/anythingllm_m0/run_true_ingest_baseline.py)

Corpus:

- `../data/anythingllm-multimodal-corpus/manifest.json`
- `../data/anythingllm-multimodal-corpus/queries.json`
- 216/216 files uploaded through `/api/v1/document/upload`
- 28 queries evaluated through `/api/v1/workspace/:slug/vector-search`
- Query topN: 20; reported R@1/R@3/R@5 and MRR

Summary:

| split | queries | R@1 | R@3 | R@5 | MRR | miss@5 |
|---|---:|---:|---:|---:|---:|---:|
| all | 28 | 0.464 | 0.536 | 0.536 | 0.513 | 13 |
| pure_visual | 13 | 0.077 | 0.154 | 0.154 | 0.138 | 11 |
| text_or_ocr | 15 | 0.800 | 0.867 | 0.867 | 0.838 | 2 |

Full outputs:

- [m0_true_ingest_baseline.md](m0_true_ingest_baseline.md)
- [m0_true_ingest_baseline.json](m0_true_ingest_baseline.json)

The pure-visual split is the expected hole: R@5 is 0.154 while text/OCR-like content is 0.867.

## Re-run Steps

Use Node 22 for all dev services:

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
```

Install dependencies if needed:

```bash
cd /Users/saprk/wici-visionary-5/anything-llm/server
yarn install --non-interactive --no-lockfile

cd /Users/saprk/wici-visionary-5/anything-llm/frontend
yarn install --non-interactive --no-lockfile

cd /Users/saprk/wici-visionary-5/anything-llm/collector
PUPPETEER_SKIP_DOWNLOAD=true yarn install --non-interactive --no-lockfile
```

Generate Prisma client and initialize the dev DB:

```bash
cd /Users/saprk/wici-visionary-5/anything-llm/server
npx prisma generate --schema=./prisma/schema.prisma
npx prisma migrate dev --name init --schema=./prisma/schema.prisma
```

Start services in separate shells:

```bash
cd /Users/saprk/wici-visionary-5/anything-llm/collector
PATH=/opt/homebrew/opt/node@22/bin:$PATH yarn dev

cd /Users/saprk/wici-visionary-5/anything-llm/server
PATH=/opt/homebrew/opt/node@22/bin:$PATH yarn dev

cd /Users/saprk/wici-visionary-5/anything-llm/frontend
PATH=/opt/homebrew/opt/node@22/bin:$PATH yarn dev
```

Health checks:

```bash
curl http://localhost:8899
curl http://localhost:3101/api/ping
```

Run the M0 true-ingest baseline:

```bash
cd /Users/saprk/wici-visionary-5/anything-llm
python3 tools/anythingllm_m0/run_true_ingest_baseline.py \
  --api-base http://localhost:3101/api \
  --report-dir reports/m0
```

## Files Added or Touched

- `.gitignore`: ignore local env files and `.m0-storage/`
- `frontend/package.json`: add missing `regenerator-runtime` dependency for existing frontend import
- `tools/anythingllm_m0/run_true_ingest_baseline.py`: M0 API-based measurement harness
- `reports/m0/ui_black_cat_miss.png`: UI before screenshot
- `reports/m0/m0_true_ingest_baseline.md`: baseline summary
- `reports/m0/m0_true_ingest_baseline.json`: full baseline data
- `reports/m0/M0_BEFORE_REPORT.md`: this handoff report
