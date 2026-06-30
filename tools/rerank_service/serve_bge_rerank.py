#!/usr/bin/env python3
"""Local BGE rerank HTTP service for AnythingLLM M2.

The service keeps the cross-encoder model loaded in-process and exposes a
small local-only API:

POST /rerank
{
  "query": "...",
  "candidates": [{"id": "optional", "text": "..."}],
  "top_k": 20
}
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path
from typing import Any

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from transformers import AutoModelForSequenceClassification, AutoTokenizer


REPO_ROOT = Path(__file__).resolve().parents[2]
WORKSPACE_ROOT = REPO_ROOT.parent
DEFAULT_CACHE_DIR = WORKSPACE_ROOT / "data/anythingllm-scale-corpus/models/hf_cache"
DEFAULT_MODEL = "BAAI/bge-reranker-base"


class Candidate(BaseModel):
  id: str | None = None
  text: str = ""


class RerankRequest(BaseModel):
  query: str
  candidates: list[Candidate] = Field(default_factory=list)
  top_k: int | None = None


def select_device(device: str) -> str:
  if device != "auto":
    return device
  if torch.backends.mps.is_available():
    return "mps"
  if torch.cuda.is_available():
    return "cuda"
  return "cpu"


class BgeReranker:
  def __init__(
    self,
    model_name: str,
    cache_dir: Path,
    device: str,
    batch_size: int,
    max_length: int,
    local_files_only: bool,
  ) -> None:
    self.model_name = model_name
    self.cache_dir = cache_dir
    self.device = select_device(device)
    self.batch_size = batch_size
    self.max_length = max_length
    started = time.perf_counter()
    self.tokenizer = AutoTokenizer.from_pretrained(
      model_name,
      cache_dir=str(cache_dir),
      local_files_only=local_files_only,
    )
    self.model = AutoModelForSequenceClassification.from_pretrained(
      model_name,
      cache_dir=str(cache_dir),
      local_files_only=local_files_only,
    )
    self.model.to(self.device)
    self.model.eval()
    self.load_s = time.perf_counter() - started

  def score_pairs(self, pairs: list[tuple[str, str]]) -> list[float]:
    scores: list[float] = []
    with torch.no_grad():
      for start in range(0, len(pairs), self.batch_size):
        batch = pairs[start : start + self.batch_size]
        inputs = self.tokenizer(
          batch,
          padding=True,
          truncation=True,
          return_tensors="pt",
          max_length=self.max_length,
        )
        inputs = {key: value.to(self.device) for key, value in inputs.items()}
        logits = self.model(**inputs).logits.view(-1)
        scores.extend(float(value) for value in logits.detach().cpu().tolist())
    return scores


def create_app(reranker: BgeReranker) -> FastAPI:
  app = FastAPI(title="AnythingLLM Local BGE Rerank Service")

  @app.get("/health")
  def health() -> dict[str, Any]:
    return {
      "ok": True,
      "model": reranker.model_name,
      "device": reranker.device,
      "batch_size": reranker.batch_size,
      "max_length": reranker.max_length,
      "load_s": reranker.load_s,
    }

  @app.post("/rerank")
  def rerank(request: RerankRequest) -> dict[str, Any]:
    query = request.query.strip()
    if not query:
      raise HTTPException(status_code=400, detail="query is required")
    candidates = request.candidates
    if not candidates:
      return {
        "results": [],
        "scores": [],
        "latency_ms": 0.0,
        "model": reranker.model_name,
        "device": reranker.device,
      }

    started = time.perf_counter()
    pairs = [(query, candidate.text or "") for candidate in candidates]
    scores = reranker.score_pairs(pairs)
    ranked = sorted(
      [
        {
          "index": index,
          "id": candidate.id,
          "score": score,
        }
        for index, (candidate, score) in enumerate(zip(candidates, scores))
      ],
      key=lambda row: row["score"],
      reverse=True,
    )
    top_k = request.top_k or len(ranked)
    latency_ms = (time.perf_counter() - started) * 1000
    return {
      "results": ranked[:top_k],
      "scores": scores,
      "latency_ms": latency_ms,
      "model": reranker.model_name,
      "device": reranker.device,
      "candidate_count": len(candidates),
    }

  return app


def main() -> int:
  parser = argparse.ArgumentParser()
  parser.add_argument("--host", default="127.0.0.1")
  parser.add_argument("--port", type=int, default=8892)
  parser.add_argument("--model", default=DEFAULT_MODEL)
  parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR)
  parser.add_argument("--device", default="auto")
  parser.add_argument("--batch-size", type=int, default=16)
  parser.add_argument("--max-length", type=int, default=512)
  parser.add_argument("--allow-download", action="store_true")
  args = parser.parse_args()

  reranker = BgeReranker(
    model_name=args.model,
    cache_dir=args.cache_dir,
    device=args.device,
    batch_size=args.batch_size,
    max_length=args.max_length,
    local_files_only=not args.allow_download,
  )
  app = create_app(reranker)
  uvicorn.run(app, host=args.host, port=args.port)
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
