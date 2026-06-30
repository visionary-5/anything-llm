#!/usr/bin/env python3
"""Run true-ingest recall against a live AnythingLLM fork.

The harness uploads corpus files through AnythingLLM's real document upload API.
For images this means: file -> collector -> configured conversion path -> text
chunks -> embedder -> LanceDB. No offline captions are injected by this script.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
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
WORKSPACE_ROOT = REPO_ROOT.parent
DEFAULT_CORPUS_ROOT = WORKSPACE_ROOT / "data/anythingllm-multimodal-corpus"
DEFAULT_REPORT_DIR = REPO_ROOT / "reports/m0"
DEFAULT_DB_PATH = REPO_ROOT / "server/storage/anythingllm.db"
DEFAULT_API_BASE = "http://localhost:3101/api"
DEFAULT_RUN_LABEL = "M0 AnythingLLM True-Ingest Baseline"
DEFAULT_INGEST_NOTE = (
  "real AnythingLLM upload API and collector; image files go through Tesseract OCR only."
)
DEFAULT_OUTPUT_PREFIX = "m0_true_ingest_baseline"
TOP_KS = (1, 3, 5)
MAX_RANK = 20


@dataclass(frozen=True)
class CorpusItem:
  item_id: str
  path: Path
  modality: str
  kind: str
  title: str


def log(message: str) -> None:
  print(message, flush=True)


def read_json(path: Path) -> Any:
  return json.loads(path.read_text(encoding="utf-8"))


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

  request = urllib.request.Request(
    url,
    data=data,
    headers=request_headers,
    method=method.upper(),
  )
  try:
    with urllib.request.urlopen(request, timeout=timeout) as response:
      raw = response.read().decode("utf-8", errors="replace")
  except urllib.error.HTTPError as exc:
    raw = exc.read().decode("utf-8", errors="replace")
    raise RuntimeError(f"{method} {url} failed: HTTP {exc.code}: {raw[:1000]}") from exc
  except urllib.error.URLError as exc:
    raise RuntimeError(f"{method} {url} failed: {exc}") from exc

  if not raw:
    return {}
  try:
    return json.loads(raw)
  except json.JSONDecodeError:
    return {"raw": raw}


def http_multipart(
  url: str,
  fields: dict[str, str],
  file_field: str,
  file_path: Path,
  headers: dict[str, str],
  timeout: int = 900,
) -> Any:
  boundary = "----m0anythingllm" + secrets.token_hex(12)
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
      f'Content-Disposition: form-data; name="{file_field}"; filename="{file_path.name}"\r\n'
      f"Content-Type: {mime}\r\n\r\n"
    ).encode("utf-8")
  )
  parts.append(file_path.read_bytes())
  parts.append(b"\r\n")
  parts.append(f"--{boundary}--\r\n".encode("utf-8"))

  request_headers = {
    "Accept": "application/json",
    "Content-Type": f"multipart/form-data; boundary={boundary}",
    **headers,
  }
  request = urllib.request.Request(
    url,
    data=b"".join(parts),
    headers=request_headers,
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


def create_workspace(api_base: str, headers: dict[str, str], name: str) -> dict[str, Any]:
  response = http_json(
    "POST",
    f"{api_base}/v1/workspace/new",
    body={
      "name": name,
      "chatMode": "query",
      "topN": MAX_RANK,
      "similarityThreshold": 0,
      "vectorSearchMode": "default",
    },
    headers=headers,
    timeout=60,
  )
  workspace = response.get("workspace")
  if isinstance(workspace, list):
    workspace = workspace[0] if workspace else None
  if not workspace or not workspace.get("slug"):
    raise RuntimeError(f"Workspace creation failed: {response}")
  return workspace


def fetch_workspace(api_base: str, headers: dict[str, str], slug: str) -> dict[str, Any]:
  response = http_json(
    "GET",
    f"{api_base}/v1/workspace/{urllib.parse.quote(slug)}",
    headers=headers,
    timeout=60,
  )
  workspace = response.get("workspace")
  if isinstance(workspace, list):
    workspace = workspace[0] if workspace else None
  if not workspace or not workspace.get("slug"):
    raise RuntimeError(f"Workspace lookup failed for {slug}: {response}")
  return workspace


def load_corpus(corpus_root: Path) -> tuple[list[CorpusItem], list[dict[str, Any]]]:
  manifest = read_json(corpus_root / "manifest.json")
  queries = read_json(corpus_root / "queries.json")
  items: list[CorpusItem] = []
  for raw in manifest["items"]:
    path = corpus_root / raw["relative_path"]
    items.append(
      CorpusItem(
        item_id=str(raw["id"]),
        path=path,
        modality=str(raw.get("modality", "")),
        kind=str(raw.get("kind", "")),
        title=str(raw.get("title", raw["id"])),
      )
    )
  return items, queries


def upload_items(
  api_base: str,
  headers: dict[str, str],
  workspace_slug: str,
  items: list[CorpusItem],
) -> list[dict[str, Any]]:
  rows: list[dict[str, Any]] = []
  for index, item in enumerate(items, start=1):
    if not item.path.exists():
      rows.append(
        {
          "item_id": item.item_id,
          "ok": False,
          "error": f"missing file: {item.path}",
          "document": None,
        }
      )
      continue

    metadata = {
      "title": item.item_id,
      "docSource": "M0 true-ingest multimodal corpus",
    }
    try:
      response = http_multipart(
        f"{api_base}/v1/document/upload",
        fields={
          "addToWorkspaces": workspace_slug,
          "metadata": json.dumps(metadata, ensure_ascii=False),
        },
        file_field="file",
        file_path=item.path,
        headers=headers,
        timeout=1200,
      )
      ok = bool(response.get("success"))
      document = (response.get("documents") or [None])[0]
      rows.append(
        {
          "index": index,
          "item_id": item.item_id,
          "path": str(item.path),
          "modality": item.modality,
          "kind": item.kind,
          "ok": ok,
          "error": response.get("error"),
          "document": document,
        }
      )
      if not ok:
        log(f"upload failed {index}/{len(items)} {item.item_id}: {response.get('error')}")
    except Exception as exc:  # noqa: BLE001 - keep evaluating remaining files
      rows.append(
        {
          "index": index,
          "item_id": item.item_id,
          "path": str(item.path),
          "modality": item.modality,
          "kind": item.kind,
          "ok": False,
          "error": str(exc),
          "document": None,
        }
      )
      log(f"upload exception {index}/{len(items)} {item.item_id}: {exc}")

    if index % 10 == 0 or index == len(items):
      ok_count = sum(1 for row in rows if row["ok"])
      log(f"uploaded {index}/{len(items)} files ({ok_count} ok)")
  return rows


def result_item_id(result: dict[str, Any], known_ids: set[str]) -> str | None:
  metadata = result.get("metadata") or {}
  title = metadata.get("title")
  if title in known_ids:
    return str(title)
  text = result.get("text") or ""
  for line in text.splitlines():
    if line.startswith("sourceDocument:"):
      candidate = line.split(":", 1)[1].strip()
      if candidate in known_ids:
        return candidate
  return None


def first_relevant_rank(ranking: list[str], gold: set[str]) -> int | None:
  for index, item_id in enumerate(ranking, start=1):
    if item_id in gold:
      return index
  return None


def query_metrics(ranking: list[str], gold: set[str]) -> dict[str, Any]:
  first_rank = first_relevant_rank(ranking, gold)
  row: dict[str, Any] = {
    "first_relevant_rank": first_rank,
    "mrr": 0.0 if first_rank is None else 1.0 / first_rank,
  }
  for k in TOP_KS:
    row[f"R@{k}"] = 1.0 if set(ranking[:k]).intersection(gold) else 0.0
  return row


def evaluate_queries(
  api_base: str,
  headers: dict[str, str],
  workspace_slug: str,
  queries: list[dict[str, Any]],
  known_ids: set[str],
) -> list[dict[str, Any]]:
  rows: list[dict[str, Any]] = []
  for index, query in enumerate(queries, start=1):
    started = time.perf_counter()
    response = http_json(
      # Server-side rerank, when enabled, is included in this request latency.
      "POST",
      f"{api_base}/v1/workspace/{urllib.parse.quote(workspace_slug)}/vector-search",
      body={"query": query["query"], "topN": MAX_RANK, "scoreThreshold": 0},
      headers=headers,
      timeout=300,
    )
    query_elapsed_s = time.perf_counter() - started
    raw_results = response.get("results") or []
    deduped: list[str] = []
    seen: set[str] = set()
    for result in raw_results:
      item_id = result_item_id(result, known_ids)
      if not item_id or item_id in seen:
        continue
      seen.add(item_id)
      deduped.append(item_id)
    gold = set(query["expected_ids"])
    metrics = query_metrics(deduped, gold)
    rows.append(
      {
        "id": query["id"],
        "query": query["query"],
        "category": query.get("category"),
        "pure_visual": bool(query.get("pure_visual")),
        "expected_ids": query["expected_ids"],
        **metrics,
        "top_ids": deduped[:MAX_RANK],
        "raw_result_count": len(raw_results),
        "query_elapsed_s": query_elapsed_s,
        "rerank_latency_ms": response.get("rerankLatencyMs"),
      }
    )
    log(
      f"query {index}/{len(queries)} {query['id']}: "
      f"rank={metrics['first_relevant_rank']} top5={deduped[:5]} "
      f"elapsed={query_elapsed_s:.3f}s rerank_ms={response.get('rerankLatencyMs')}"
    )
  return rows


def mean(values: list[float]) -> float:
  return sum(values) / len(values) if values else 0.0


def aggregate(rows: list[dict[str, Any]]) -> dict[str, Any]:
  out: dict[str, Any] = {"query_count": len(rows)}
  for k in TOP_KS:
    out[f"R@{k}"] = mean([row[f"R@{k}"] for row in rows])
  out["MRR"] = mean([row["mrr"] for row in rows])
  out["miss_at_5_count"] = sum(1 for row in rows if row["R@5"] == 0.0)
  out["mean_query_elapsed_s"] = mean([row.get("query_elapsed_s", 0.0) for row in rows])
  rerank_latencies = [
    row["rerank_latency_ms"] / 1000
    for row in rows
    if row.get("rerank_latency_ms") is not None
  ]
  out["mean_rerank_latency_s"] = mean(rerank_latencies)
  return out


def grouped_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
  pure_rows = [row for row in rows if row["pure_visual"]]
  text_rows = [row for row in rows if not row["pure_visual"]]
  by_category = {}
  for category in sorted({str(row["category"]) for row in rows}):
    by_category[category] = aggregate([row for row in rows if row["category"] == category])
  return {
    "all": aggregate(rows),
    "pure_visual": aggregate(pure_rows),
    "text_or_ocr": aggregate(text_rows),
    "by_category": by_category,
  }


def write_markdown(path: Path, report: dict[str, Any]) -> None:
  summary = report["summary"]
  lines = [
    f"# {report['settings'].get('run_label', DEFAULT_RUN_LABEL)}",
    "",
    "## Settings",
    "",
    f"- API base: `{report['settings']['api_base']}`",
    f"- Workspace: `{report['workspace']['slug']}`",
    f"- Corpus items uploaded: {report['upload_summary']['ok']}/{report['upload_summary']['total']}",
    f"- Query topN: {MAX_RANK}; reported recall: R@1/R@3/R@5; MRR uses first relevant rank within top{MAX_RANK}.",
    f"- Ingest path: {report['settings'].get('ingest_path_note', DEFAULT_INGEST_NOTE)}",
    "",
    "## Summary",
    "",
    "| split | queries | R@1 | R@3 | R@5 | MRR | miss@5 | query_s | rerank_s |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ]
  for split in ("all", "pure_visual", "text_or_ocr"):
    row = summary[split]
    lines.append(
      f"| {split} | {row['query_count']} | {row['R@1']:.3f} | {row['R@3']:.3f} | "
      f"{row['R@5']:.3f} | {row['MRR']:.3f} | {row['miss_at_5_count']} | "
      f"{row['mean_query_elapsed_s']:.3f} | {row['mean_rerank_latency_s']:.3f} |"
    )

  lines.extend(["", "## By Category", ""])
  lines.extend(["| category | queries | R@1 | R@3 | R@5 | MRR |", "|---|---:|---:|---:|---:|---:|"])
  for category, row in summary["by_category"].items():
    lines.append(
      f"| {category} | {row['query_count']} | {row['R@1']:.3f} | {row['R@3']:.3f} | "
      f"{row['R@5']:.3f} | {row['MRR']:.3f} |"
    )

  lines.extend(["", "## Query Rows", ""])
  lines.extend(
    [
      "| id | pure_visual | rank | query_s | rerank_s | top5 |",
      "|---|---:|---:|---:|---:|---|",
    ]
  )
  for row in report["query_rows"]:
    rank = row["first_relevant_rank"] if row["first_relevant_rank"] is not None else "miss"
    rerank_s = (
      ""
      if row.get("rerank_latency_ms") is None
      else f"{row['rerank_latency_ms'] / 1000:.3f}"
    )
    lines.append(
      f"| {row['id']} | {str(row['pure_visual']).lower()} | {rank} | "
      f"{row.get('query_elapsed_s', 0.0):.3f} | {rerank_s} | "
      f"{', '.join(row['top_ids'][:5])} |"
    )

  if report["upload_summary"]["failed"]:
    lines.extend(["", "## Upload Failures", ""])
    for row in report["upload_rows"]:
      if not row["ok"]:
        lines.append(f"- `{row['item_id']}`: {row['error']}")

  path.parent.mkdir(parents=True, exist_ok=True)
  path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
  parser = argparse.ArgumentParser()
  parser.add_argument("--api-base", default=DEFAULT_API_BASE)
  parser.add_argument("--db-path", type=Path, default=DEFAULT_DB_PATH)
  parser.add_argument("--corpus-root", type=Path, default=DEFAULT_CORPUS_ROOT)
  parser.add_argument("--report-dir", type=Path, default=DEFAULT_REPORT_DIR)
  parser.add_argument("--api-key-name", default="m0-baseline")
  parser.add_argument("--workspace-name", default=None)
  parser.add_argument("--workspace-slug", default=None)
  parser.add_argument("--skip-upload", action="store_true")
  parser.add_argument("--run-label", default=DEFAULT_RUN_LABEL)
  parser.add_argument("--ingest-path-note", default=DEFAULT_INGEST_NOTE)
  parser.add_argument("--output-prefix", default=DEFAULT_OUTPUT_PREFIX)
  parser.add_argument("--limit-items", type=int, default=None)
  parser.add_argument("--limit-queries", type=int, default=None)
  args = parser.parse_args()

  api_base = args.api_base.rstrip("/")
  started = time.strftime("%Y%m%d-%H%M%S")
  workspace_name = args.workspace_name or f"M0 API Baseline {started}"
  items, queries = load_corpus(args.corpus_root)
  if args.limit_items:
    items = items[: args.limit_items]
  if args.limit_queries:
    queries = queries[: args.limit_queries]

  ping = http_json("GET", f"{api_base}/ping", timeout=10)
  api_key = ensure_api_key(api_base, args.db_path, args.api_key_name)
  headers = auth_headers(api_key)
  if args.skip_upload:
    if not args.workspace_slug:
      raise RuntimeError("--skip-upload requires --workspace-slug")
    workspace = fetch_workspace(api_base, headers, args.workspace_slug)
  else:
    workspace = create_workspace(api_base, headers, workspace_name)
  workspace_slug = workspace["slug"]
  log(f"{'using existing' if args.skip_upload else 'created'} workspace {workspace_slug}")

  upload_rows = [] if args.skip_upload else upload_items(api_base, headers, workspace_slug, items)
  known_ids = {item.item_id for item in items}
  query_rows = evaluate_queries(api_base, headers, workspace_slug, queries, known_ids)
  upload_summary = {
    "total": len(upload_rows) if not args.skip_upload else len(items),
    "ok": sum(1 for row in upload_rows if row["ok"]) if not args.skip_upload else len(items),
    "failed": sum(1 for row in upload_rows if not row["ok"]) if not args.skip_upload else 0,
    "skipped": bool(args.skip_upload),
  }
  report = {
    "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    "settings": {
      "api_base": api_base,
      "db_path": str(args.db_path),
      "corpus_root": str(args.corpus_root),
      "max_rank": MAX_RANK,
      "top_ks": TOP_KS,
      "ping": ping,
      "run_label": args.run_label,
      "ingest_path_note": args.ingest_path_note,
    },
    "workspace": workspace,
    "upload_summary": upload_summary,
    "summary": grouped_summary(query_rows),
    "query_rows": query_rows,
    "upload_rows": upload_rows,
  }

  json_path = args.report_dir / f"{args.output_prefix}.json"
  md_path = args.report_dir / f"{args.output_prefix}.md"
  write_json(json_path, report)
  write_markdown(md_path, report)
  log(f"wrote {json_path}")
  log(f"wrote {md_path}")
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
