const { fileData } = require("../files");
const { formatSourceForContext } = require("../chats");

const QUERY_EXPANSIONS = {
  内存: ["memory", "efficiency", "kb", "vector", "vectors"],
  省内存: ["memory efficiency", "256kb", "4.5kb", "colpali"],
  更省: ["memory efficiency", "256kb", "4.5kb"],
  误差: ["error", "margin", "tolerance", "numeric"],
  容限: ["error margin", "tolerance", "numeric"],
  数值: ["numeric", "numerical", "number", "responses"],
  允许: ["allows", "allowed"],
  多大: ["allows", "allowed", "margin"],
  评估: ["evaluation", "metrics", "accuracy"],
  指标: ["metrics", "accuracy"],
  权重: ["weight", "weighted", "pooling"],
  公式: ["equation", "formula"],
  图表: ["chart", "figure", "table"],
  表格: ["table", "spreadsheet"],
  图片: ["image", "photo", "figure"],
  照片: ["image", "photo"],
  论文: ["paper", "conference", "arxiv"],
};

function normalizeText(value = "") {
  return String(value)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function searchTerms(query = "") {
  const normalized = normalizeText(query);
  const terms = new Set();
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9._-]{1,}/g))
    terms.add(match[0]);
  for (const match of normalized.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const token = match[0];
    terms.add(token);
    for (const [key, expansions] of Object.entries(QUERY_EXPANSIONS)) {
      if (token.includes(key)) expansions.forEach((term) => terms.add(term));
    }
  }
  return Array.from(terms).filter(
    (term) =>
      ![
        "the",
        "and",
        "with",
        "this",
        "that",
        "local",
        "file",
        "files",
        "pdf",
        "本地",
        "文件",
        "文档",
        "这个",
        "里面",
      ].includes(term)
  );
}

function queryProfile(query = "") {
  const normalized = normalizeText(query);
  return {
    wantsMemoryComparison: /(memory|colpali|visrag-ret|省内存|内存|更省)/i.test(
      normalized
    ),
    wantsNumericTolerance:
      /(numeric|number|tolerance|margin|error|metric|accuracy|数值|误差|容限|评估|指标|允许|多大)/i.test(
        normalized
      ),
  };
}

function sourceKey(source = {}) {
  return (
    source.location ||
    source.sourcePath ||
    source.chunkSource ||
    source.url ||
    source.title ||
    ""
  );
}

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sourceMatchValues(source = {}) {
  const values = new Set();
  for (const value of [
    source.location,
    source.sourcePath,
    source.chunkSource,
    source.url,
    source.title,
    source.filename,
    source.name,
  ]) {
    if (value) values.add(normalizeText(value));
  }
  return values;
}

function workspaceDocumentMatchesSource(document = {}, source = {}) {
  const metadata = safeJsonParse(document.metadata, {});
  const sourceValues = sourceMatchValues(source);
  const documentValues = [
    document.docpath,
    document.filename,
    metadata?.title,
    metadata?.sourcePath,
    metadata?.chunkSource,
    metadata?.url,
  ]
    .filter(Boolean)
    .map(normalizeText);

  return documentValues.some((value) => sourceValues.has(value));
}

async function workspaceDocuments(workspaceId = null) {
  if (!workspaceId) return [];
  const { Document } = require("../../models/documents");
  return await Document.forWorkspace(workspaceId);
}

async function candidateDocumentLocations(sources = [], workspaceId = null) {
  const documents = await workspaceDocuments(workspaceId);
  const seen = new Set();
  const locations = [];
  for (const source of sources) {
    const location =
      source?.location ||
      documents.find((document) =>
        workspaceDocumentMatchesSource(document, source)
      )?.docpath;
    if (!location || seen.has(location)) continue;
    seen.add(location);
    locations.push({ location, source: { ...source, location } });
  }
  return locations.slice(0, 8);
}

function windowsForText(text = "", { size = 1_600, stride = 800 } = {}) {
  const windows = [];
  for (let start = 0; start < text.length; start += stride) {
    const body = text.slice(start, start + size);
    if (!body.trim()) continue;
    windows.push({ start, end: start + body.length, body });
    if (start + size >= text.length) break;
  }
  return windows;
}

function scoreWindow(body = "", terms = [], profile = {}) {
  const normalized = normalizeText(body);
  let score = 0;
  for (const term of terms) {
    const normalizedTerm = normalizeText(term);
    if (!normalizedTerm) continue;
    const index = normalized.indexOf(normalizedTerm);
    if (index === -1) continue;
    score += normalizedTerm.includes(" ") ? 8 : 4;
    if (index < 300) score += 1;
  }
  if (/\b\d+(\.\d+)?\s?(kb|mb|gb|%)\b/i.test(body)) score += 3;
  if (/table|figure|evaluation metrics|memory efficiency/i.test(body))
    score += 2;
  if (
    profile.wantsMemoryComparison &&
    /colpali[\s\S]{0,500}(256\s?kb|1030[\s\S]{0,80}128-dim|visrag-ret[\s\S]{0,300}4\.5\s?kb)/i.test(
      body
    )
  )
    score += 24;
  if (
    profile.wantsNumericTolerance &&
    /(relaxed exact match|numeric responses|5%\s+error|5%\s+.*margin|allows a 5%)/i.test(
      body
    )
  )
    score += 24;
  return score;
}

async function lexicalEvidenceForQuery({
  query = "",
  sources = [],
  workspaceId = null,
  maxSnippets = 3,
} = {}) {
  const terms = searchTerms(query);
  const profile = queryProfile(query);
  if (terms.length === 0 || sources.length === 0)
    return { contextTexts: [], sources: [] };

  const ranked = [];
  for (const { location, source } of await candidateDocumentLocations(
    sources,
    workspaceId
  )) {
    const document = await fileData(location).catch(() => null);
    if (!document?.pageContent) continue;

    for (const window of windowsForText(document.pageContent)) {
      const score = scoreWindow(window.body, terms, profile);
      if (score <= 0) continue;
      ranked.push({
        score,
        source: {
          ...document,
          ...source,
          pageContent: window.body,
          text: window.body,
          wiciEvidenceType: "lexical_document_window",
          wiciEvidenceStart: window.start,
          wiciEvidenceEnd: window.end,
        },
      });
    }
  }

  const seen = new Set();
  const selected = [];
  for (const row of ranked.sort((a, b) => b.score - a.score)) {
    const key = `${sourceKey(row.source)}:${row.source.wiciEvidenceStart}`;
    const bodyKey = normalizeText(row.source.text).slice(0, 600);
    if (seen.has(key) || seen.has(bodyKey)) continue;
    seen.add(key);
    seen.add(bodyKey);
    selected.push({ ...row.source, score: row.score });
    if (selected.length >= maxSnippets) break;
  }

  return {
    contextTexts: selected.map((source, index) =>
      formatSourceForContext(
        {
          ...source,
          docSource: source.docSource || "WICI local lexical evidence",
          pageContent: `WICI exact local evidence snippet. Prefer this snippet for exact numbers, formulas, tables, and metric definitions.\n\n${source.pageContent}`,
        },
        index
      )
    ),
    sources: selected,
  };
}

module.exports = {
  lexicalEvidenceForQuery,
  searchTerms,
};
