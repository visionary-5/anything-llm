# M5 Local Source UI Report

## What Changed

This round turns the previous local folder CLI into an AnythingLLM UI workflow.

- Existing manual upload remains unchanged.
- Workspace document management now has a `Local folders` panel.
- The panel can dry-run a local path, then start a background indexing job.
- Paths are read by the local AnythingLLM server, not by the browser.
- Ingest still uses the real collector path: local file -> collector -> OCR + WICI VLM card -> embed -> LanceDB.

The new behavior is gated by:

```bash
WICI_LOCAL_SOURCES_ENABLED=false
```

If unset, the fork enables local sources by default.

## User Flow

Open the local demo at:

```text
http://127.0.0.1:3000
```

In a workspace, open document management and use `Local folders`.

Preset paths:

- `~/Pictures`
- `~/Documents`
- `~/Downloads`
- `~`
- `/` as `All Mac` for advanced broad scans

Custom paths can be typed one per line. The user can run `Dry run` first to see how many files will be indexed, then `Index now`.

## Backend Design

New module:

```text
server/utils/wiciLocalSources/index.js
```

New workspace endpoints:

```text
GET  /api/workspace/:slug/local-sources
POST /api/workspace/:slug/local-sources/preview
POST /api/workspace/:slug/local-sources/index
GET  /api/workspace/:slug/local-sources/job/:jobId
```

Runtime state is kept per workspace under:

```text
server/storage/wici-local-sources/
```

That directory is ignored by git. State stores local file fingerprints so unchanged files are skipped. If a known local path changes, the new file is processed first; only after success does the old workspace embedding get removed.

## Verification

Dry run against the existing local demo folder:

```text
/tmp/wici-local-dir-demo
```

Result:

```json
{
  "seen": 3,
  "changedOrNew": 3,
  "unchanged": 0,
  "toIndex": 3
}
```

Index smoke workspace:

```text
WICI Local Source UI Smoke
slug: wici-local-source-ui-smoke
```

Job:

```text
ae05acb0-4d65-47c6-a063-e9b4d592027b
```

Result:

```json
{
  "seen": 3,
  "changedOrNew": 3,
  "attempted": 3,
  "ok": 3,
  "failed": 0
}
```

Database check:

```text
workspace_documents: 3
```

The indexed documents include the expected WICI visual cards, for example the camera-phone image has:

```text
SEARCH_SUMMARY: A Sony DSLR camera and an older flip phone are placed on a wooden surface.
OBJECTS: Sony DSLR camera, flip phone with screen display
RELATIONSHIPS: Flip phone is in front of the camera on a wooden surface.
```

## Notes

- This is still explicit indexing, not continuous watching.
- Browser folder picking is not used because the browser cannot safely grant full-disk access to a web app. The local server reads the user-provided path.
- Broad scans such as `/` are available but capped by scan limits and skip system-heavy folders.
- The next product step is a managed background watcher with folder permissions, delete/update reconciliation, and a clearer source-path answer renderer.
