const DEFAULT_RERANK_URL = "http://127.0.0.1:8892/rerank";
const DEFAULT_POOL = 50;
const DEFAULT_TIMEOUT_MS = 30_000;

function envFlagEnabled(name, defaultValue = true) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "")
    return defaultValue;
  return !["0", "false", "off", "no", "disabled"].includes(
    String(value).trim().toLowerCase()
  );
}

function isWiciRerankEnabled() {
  return envFlagEnabled("WICI_RERANK_ENABLED", true);
}

function getWiciRerankUrl() {
  return process.env.WICI_RERANK_URL || DEFAULT_RERANK_URL;
}

function getWiciRerankPool() {
  const input = Number(process.env.WICI_RERANK_POOL);
  if (!Number.isInteger(input) || input < 1) return DEFAULT_POOL;
  return input;
}

async function rerankDocuments(query, documents = [], { topK = 4 } = {}) {
  if (!isWiciRerankEnabled() || !documents.length) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(getWiciRerankUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        candidates: documents.map((document, index) => ({
          id: document.id || String(index),
          text: document.text || "",
        })),
        top_k: Math.min(topK, documents.length),
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok)
      throw new Error(`HTTP ${response.status}: ${raw.slice(0, 500)}`);

    const payload = JSON.parse(raw);
    const ranked = (payload.results || [])
      .map((item) => {
        const document = documents[item.index];
        if (!document) return null;
        return {
          ...document,
          rerank_score: item.score,
        };
      })
      .filter(Boolean);

    return {
      documents: ranked,
      latencyMs: payload.latency_ms ?? null,
      candidateCount: payload.candidate_count ?? documents.length,
      model: payload.model,
      device: payload.device,
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  getWiciRerankPool,
  getWiciRerankUrl,
  isWiciRerankEnabled,
  rerankDocuments,
};
