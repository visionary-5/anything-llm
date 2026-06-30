#!/usr/bin/env python3
"""Index local directories into an AnythingLLM workspace.

This is a local-first bridge from "manual upload" to "folder memory":

  local folder -> AnythingLLM upload API -> collector -> OCR/VLM enrichment
  -> embedding -> LanceDB -> workspace search

The tool intentionally uses the public dev API instead of importing server code
so it exercises the same ingest path as the UI.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import secrets
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_API_BASE = "http://127.0.0.1:3101/api"
DEFAULT_DB_PATH = REPO_ROOT / "server/storage/anythingllm.db"
DEFAULT_STATE_PATH = REPO_ROOT / "server/storage/wici-local-dir-indexer/manifest.json"
DEFAULT_WORKSPACE_NAME = "WICI Local Folder Memory"
DEFAULT_EXTENSIONS = {
  ".bmp",
  ".csv",
  ".docx",
  ".gif",
  ".jpeg",
  ".jpg",
  ".json",
  ".md",
  ".pdf",
  ".png",
  ".txt",
  ".webp",
  ".xlsx",
}
SKIP_DIR_NAMES = {
  ".git",
  ".hg",
  ".svn",
  ".DS_Store",
  "__pycache__",
  "node_modules",
  "venv",
  ".venv",
  ".m0-storage",
  ".m2-rerank-venv",
  "wici-enrichment-cache",
}


@dataclass(frozen=True)
class FileFingerprint:
  path: Path
  size: int
  mtime_ns: int

  @property
  def key(self) -> str:
    return str(self.path.resolve())

  @property
  def signature(self) -> str:
    return f"{self.size}:{self.mtime_ns}"


def log(message: str) -> None:
  print(message, flush=True)


def read_json(path: Path, default: Any) -> Any:
  if not path.exists():
    return default
  try:
    return json.loads(path.read_text(encoding="utf-8"))
  except json.JSONDecodeError:
    return default


def write_json(path: Path, data: Any) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def http_json(
  method: str,
  url: str,
  body: dict[str, Any] | None = None,
  headers: dict[str, str] | None = None,
  timeout: int = 300,
) -> Any:
  data = None
  request_headers = {"Accept": "application/json"}
  if headers:
    request_headers.update(headers)
  if body is not None:
    data = json.dumps(body).encode("utf-8")
    request_headers["Content-Type"] = "application/json"

  request = urllib.request.Request(url, data=data, headers=request_headers, method=method.upper())
  try:
    with urllib.request.urlopen(request, timeout=timeout) as response:
      raw = response.read().decode("utf-8", errors="replace")
  except urllib.error.HTTPError as exc:
    raw = exc.read().decode("utf-8", errors="replace")
    raise RuntimeError(f"{method} {url} failed: HTTP {exc.code}: {raw[:1000]}") from exc
  except urllib.error.URLError as exc:
    raise RuntimeError(f"{method} {url} failed: {exc}") from exc

  return json.loads(raw) if raw else {}


def http_multipart_upload(
  url: str,
  file_path: Path,
  fields: dict[str, str],
  headers: dict[str, str],
  timeout: int,
) -> Any:
  boundary = "----wici-local-dir-" + secrets.token_hex(12)
  parts: list[bytes] = []

  for name, value in fields.items():
    parts.append(f"--{boundary}\r\n".encode("utf-8"))
    parts.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"))
    parts.append(value.encode("utf-8"))
    parts.append(b"\r\n")

  mime = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
  parts.append(f"--{boundary}\r\n".encode("utf-8"))
  parts.append(
    (
      f'Content-Disposition: form-data; name="file"; filename="{file_path.name}"\r\n'
      f"Content-Type: {mime}\r\n\r\n"
    ).encode("utf-8")
  )
  parts.append(file_path.read_bytes())
  parts.append(b"\r\n")
  parts.append(f"--{boundary}--\r\n".encode("utf-8"))

  request = urllib.request.Request(
    url,
    data=b"".join(parts),
    headers={
      "Accept": "application/json",
      "Content-Type": f"multipart/form-data; boundary={boundary}",
      **headers,
    },
    method="POST",
  )
  try:
    with urllib.request.urlopen(request, timeout=timeout) as response:
      raw = response.read().decode("utf-8", errors="replace")
  except urllib.error.HTTPError as exc:
    raw = exc.read().decode("utf-8", errors="replace")
    raise RuntimeError(f"POST {url} failed: HTTP {exc.code}: {raw[:1000]}") from exc
  return json.loads(raw) if raw else {}


def auth_headers(api_key: str) -> dict[str, str]:
  return {"Authorization": f"Bearer {api_key}"}


def read_named_api_key(db_path: Path, name: str) -> str | None:
  if not db_path.exists():
    return None
  with sqlite3.connect(str(db_path)) as conn:
    row = conn.execute(
      "select secret from api_keys where name = ? order by id desc limit 1",
      (name,),
    ).fetchone()
    if row and row[0]:
      return str(row[0])
    row = conn.execute("select secret from api_keys order by id asc limit 1").fetchone()
    return str(row[0]) if row and row[0] else None


def ensure_api_key(api_base: str, db_path: Path, name: str) -> str:
  existing = read_named_api_key(db_path, name)
  if existing:
    return existing
  response = http_json(
    "POST",
    f"{api_base}/system/generate-api-key",
    body={"name": name},
    timeout=30,
  )
  api_key = response.get("apiKey", {})
  secret = api_key.get("secret")
  if not secret:
    raise RuntimeError(f"Failed to create API key: {response}")
  return str(secret)


def workspace_from_response(response: dict[str, Any]) -> dict[str, Any] | None:
  workspace = response.get("workspace")
  if isinstance(workspace, list):
    return workspace[0] if workspace else None
  return workspace if isinstance(workspace, dict) else None


def fetch_workspace(api_base: str, headers: dict[str, str], slug: str) -> dict[str, Any] | None:
  try:
    response = http_json(
      "GET",
      f"{api_base}/v1/workspace/{urllib.parse.quote(slug)}",
      headers=headers,
      timeout=60,
    )
    workspace = workspace_from_response(response)
    return workspace if workspace and workspace.get("slug") else None
  except Exception:
    return None


def create_workspace(api_base: str, headers: dict[str, str], name: str) -> dict[str, Any]:
  response = http_json(
    "POST",
    f"{api_base}/v1/workspace/new",
    body={
      "name": name,
      "chatMode": "query",
      "topN": 20,
      "similarityThreshold": 0,
      "vectorSearchMode": "default",
    },
    headers=headers,
    timeout=60,
  )
  workspace = workspace_from_response(response)
  if not workspace or not workspace.get("slug"):
    raise RuntimeError(f"Workspace creation failed: {response}")
  return workspace


def ensure_workspace(
  api_base: str,
  headers: dict[str, str],
  workspace_slug: str | None,
  workspace_name: str,
) -> dict[str, Any]:
  if workspace_slug:
    workspace = fetch_workspace(api_base, headers, workspace_slug)
    if workspace:
      return workspace
    raise RuntimeError(f"Workspace slug {workspace_slug!r} was not found.")
  return create_workspace(api_base, headers, workspace_name)


def parse_extensions(values: list[str]) -> set[str]:
  if not values:
    return set(DEFAULT_EXTENSIONS)
  extensions: set[str] = set()
  for value in values:
    for entry in value.split(","):
      entry = entry.strip().lower()
      if not entry:
        continue
      extensions.add(entry if entry.startswith(".") else f".{entry}")
  return extensions


def iter_files(roots: list[Path], extensions: set[str], max_bytes: int) -> list[FileFingerprint]:
  files: list[FileFingerprint] = []
  for root in roots:
    root = root.expanduser().resolve()
    if not root.exists():
      log(f"[skip] missing root: {root}")
      continue
    if root.is_file():
      candidates = [root]
    else:
      candidates = []
      for current_root, dir_names, file_names in os.walk(root):
        dir_names[:] = [name for name in dir_names if name not in SKIP_DIR_NAMES]
        for file_name in file_names:
          candidates.append(Path(current_root) / file_name)

    for path in candidates:
      try:
        if path.suffix.lower() not in extensions:
          continue
        stat = path.stat()
        if not path.is_file() or stat.st_size <= 0:
          continue
        if max_bytes > 0 and stat.st_size > max_bytes:
          log(f"[skip] too large: {path} ({stat.st_size} bytes)")
          continue
        files.append(FileFingerprint(path=path, size=stat.st_size, mtime_ns=stat.st_mtime_ns))
      except OSError as exc:
        log(f"[skip] unreadable: {path}: {exc}")
  files.sort(key=lambda item: item.key)
  return files


def load_state(path: Path) -> dict[str, Any]:
  state = read_json(path, {"version": 1, "files": {}})
  if "files" not in state or not isinstance(state["files"], dict):
    state["files"] = {}
  return state


def should_upload(fingerprint: FileFingerprint, state: dict[str, Any], force: bool) -> bool:
  if force:
    return True
  row = state["files"].get(fingerprint.key)
  if not row:
    return True
  return row.get("signature") != fingerprint.signature


def upload_file(
  api_base: str,
  headers: dict[str, str],
  workspace_slug: str,
  fingerprint: FileFingerprint,
  timeout: int,
) -> dict[str, Any]:
  metadata = {
    "title": fingerprint.path.name,
    "docAuthor": "local filesystem",
    "description": f"Auto-indexed from local directory: {fingerprint.path}",
    "docSource": "WICI local directory indexer",
    "chunkSource": f"file://{fingerprint.path}",
  }
  return http_multipart_upload(
    f"{api_base}/v1/document/upload",
    file_path=fingerprint.path,
    fields={
      "addToWorkspaces": workspace_slug,
      "metadata": json.dumps(metadata, ensure_ascii=False),
    },
    headers=headers,
    timeout=timeout,
  )


def vector_search(
  api_base: str,
  headers: dict[str, str],
  workspace_slug: str,
  query: str,
  top_n: int,
) -> dict[str, Any]:
  return http_json(
    "POST",
    f"{api_base}/v1/workspace/{urllib.parse.quote(workspace_slug)}/vector-search",
    body={"query": query, "topN": top_n, "scoreThreshold": 0},
    headers=headers,
    timeout=120,
  )


def index_once(args: argparse.Namespace) -> dict[str, Any]:
  api_base = args.api_base.rstrip("/")
  api_key = ensure_api_key(api_base, args.db_path, args.api_key_name)
  headers = auth_headers(api_key)
  ping = http_json("GET", f"{api_base}/ping", timeout=10)
  if not ping.get("online"):
    raise RuntimeError(f"AnythingLLM API is not online: {ping}")

  workspace = ensure_workspace(api_base, headers, args.workspace_slug, args.workspace_name)
  workspace_slug = workspace["slug"]
  extensions = parse_extensions(args.extensions)
  roots = [Path(root) for root in args.roots]
  state = load_state(args.state_path)
  fingerprints = iter_files(roots, extensions, args.max_bytes)
  candidates = [fp for fp in fingerprints if should_upload(fp, state, args.force)]
  if args.limit is not None:
    candidates = candidates[: args.limit]

  log(
    f"workspace={workspace_slug} roots={len(roots)} files={len(fingerprints)} "
    f"to_upload={len(candidates)} dry_run={args.dry_run}"
  )

  rows: list[dict[str, Any]] = []
  started = time.time()
  for index, fingerprint in enumerate(candidates, start=1):
    row: dict[str, Any] = {
      "path": fingerprint.key,
      "signature": fingerprint.signature,
      "size": fingerprint.size,
      "ok": False,
      "error": None,
      "documents": [],
    }

    if args.dry_run:
      row["ok"] = True
      row["dry_run"] = True
      rows.append(row)
      log(f"[dry-run] {index}/{len(candidates)} {fingerprint.path}")
      continue

    try:
      response = upload_file(api_base, headers, workspace_slug, fingerprint, args.upload_timeout)
      ok = bool(response.get("success"))
      row["ok"] = ok
      row["error"] = response.get("error")
      row["documents"] = response.get("documents") or []
      if ok:
        state["files"][fingerprint.key] = {
          "signature": fingerprint.signature,
          "size": fingerprint.size,
          "workspace": workspace_slug,
          "documents": row["documents"],
          "indexed_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }
        write_json(args.state_path, state)
      log(f"[{'ok' if ok else 'fail'}] {index}/{len(candidates)} {fingerprint.path}")
    except Exception as exc:  # noqa: BLE001 - keep indexing remaining files
      row["error"] = str(exc)
      log(f"[error] {index}/{len(candidates)} {fingerprint.path}: {exc}")
    rows.append(row)

  report = {
    "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    "workspace": workspace,
    "roots": [str(Path(root).expanduser().resolve()) for root in roots],
    "extensions": sorted(extensions),
    "state_path": str(args.state_path),
    "dry_run": args.dry_run,
    "force": args.force,
    "summary": {
      "seen": len(fingerprints),
      "attempted": len(candidates),
      "ok": sum(1 for row in rows if row["ok"]),
      "failed": sum(1 for row in rows if not row["ok"]),
      "elapsed_s": time.time() - started,
    },
    "rows": rows,
  }
  if args.smoke_query:
    smoke_rows = []
    for query in args.smoke_query:
      try:
        response = vector_search(
          api_base,
          headers,
          workspace_slug,
          query,
          args.query_top_n,
        )
        smoke_rows.append(
          {
            "query": query,
            "ok": True,
            "rerankLatencyMs": response.get("rerankLatencyMs"),
            "top": [
              {
                "title": (item.get("metadata") or {}).get("title"),
                "score": item.get("score"),
                "snippet": (item.get("text") or "")[:500],
              }
              for item in (response.get("results") or [])[: args.query_top_n]
            ],
          }
        )
        top_title = smoke_rows[-1]["top"][0]["title"] if smoke_rows[-1]["top"] else "none"
        log(f"[query] {query!r} -> {top_title}")
      except Exception as exc:  # noqa: BLE001 - preserve index report even if query fails
        smoke_rows.append({"query": query, "ok": False, "error": str(exc), "top": []})
        log(f"[query-error] {query!r}: {exc}")
    report["smoke_queries"] = smoke_rows

  if args.report:
    write_json(args.report, report)
    log(f"wrote {args.report}")
  return report


def main() -> int:
  parser = argparse.ArgumentParser()
  parser.add_argument("roots", nargs="*", help="Local files or directories to index.")
  parser.add_argument("--api-base", default=DEFAULT_API_BASE)
  parser.add_argument("--db-path", type=Path, default=DEFAULT_DB_PATH)
  parser.add_argument("--api-key-name", default="wici-local-dir-indexer")
  parser.add_argument("--workspace-slug", default=None)
  parser.add_argument("--workspace-name", default=DEFAULT_WORKSPACE_NAME)
  parser.add_argument("--state-path", type=Path, default=DEFAULT_STATE_PATH)
  parser.add_argument("--report", type=Path, default=None)
  parser.add_argument("--extensions", action="append", default=[])
  parser.add_argument("--max-bytes", type=int, default=50 * 1024 * 1024)
  parser.add_argument("--upload-timeout", type=int, default=1200)
  parser.add_argument("--limit", type=int, default=None)
  parser.add_argument("--smoke-query", action="append", default=[])
  parser.add_argument("--query-top-n", type=int, default=5)
  parser.add_argument("--force", action="store_true")
  parser.add_argument("--dry-run", action="store_true")
  parser.add_argument("--watch", action="store_true")
  parser.add_argument("--interval", type=int, default=60)
  args = parser.parse_args()

  env_roots = os.environ.get("WICI_LOCAL_INDEX_DIRS", "")
  if not args.roots and env_roots:
    args.roots = [entry.strip() for entry in env_roots.split(",") if entry.strip()]
  if not args.roots:
    parser.error("Provide at least one root path or set WICI_LOCAL_INDEX_DIRS.")

  while True:
    index_once(args)
    if not args.watch:
      break
    time.sleep(max(5, args.interval))
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
