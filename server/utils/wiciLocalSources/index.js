const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { CollectorApi } = require("../collectorApi");
const { hotdirPath, isWithin, sanitizeFileName } = require("../files");
const { Document } = require("../../models/documents");

const DEFAULT_EXTENSIONS = [
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
];
const DEFAULT_ON_DEMAND_DOCUMENT_EXTENSIONS = [
  ".csv",
  ".docx",
  ".json",
  ".md",
  ".pdf",
  ".txt",
  ".xlsx",
];
const DEFAULT_ON_DEMAND_IMAGE_EXTENSIONS = [
  ".bmp",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
];
const CODE_OR_DATA_EXTENSIONS = new Set([".csv", ".json", ".md"]);
const EXTENSION_PRIORITY = {
  ".pdf": 0,
  ".docx": 1,
  ".xlsx": 1,
  ".png": 2,
  ".jpg": 2,
  ".jpeg": 2,
  ".webp": 2,
  ".gif": 2,
  ".bmp": 2,
  ".md": 3,
  ".txt": 3,
  ".csv": 4,
  ".json": 5,
};
const SKIP_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".DS_Store",
  ".Trash",
  ".cache",
  ".cargo",
  ".conda",
  ".gradle",
  ".local",
  ".npm",
  ".pnpm-store",
  ".pyenv",
  ".rustup",
  ".tox",
  ".turbo",
  ".yarn",
  ".next",
  ".parcel-cache",
  "__pycache__",
  "Applications",
  "build",
  "Caches",
  "coverage",
  "DerivedData",
  "dist",
  "env",
  "Library",
  "logs",
  "miniconda3",
  "System",
  "node_modules",
  "Pods",
  "private",
  "site-packages",
  "target",
  "venv",
  ".venv",
  ".m0-storage",
  ".m2-rerank-venv",
  "wici-enrichment-cache",
  "wici-local-dir-indexer",
  "wici-local-sources",
]);
const USER_ROOT_PRIORITY = [
  "Documents",
  "Downloads",
  "Desktop",
  "Pictures",
  "Movies",
  "Music",
];
const jobs = new Map();

function storageRoot() {
  if (process.env.STORAGE_DIR) return path.resolve(process.env.STORAGE_DIR);
  return path.resolve(__dirname, "../../storage");
}

function stateDir() {
  return path.resolve(
    process.env.WICI_LOCAL_SOURCES_STATE_DIR ||
      path.join(storageRoot(), "wici-local-sources")
  );
}

function statePath(workspaceSlug) {
  return path.join(stateDir(), `${sanitizeFileName(workspaceSlug)}.json`);
}

function localSourcesEnabled() {
  return String(process.env.WICI_LOCAL_SOURCES_ENABLED ?? "true") !== "false";
}

function onDemandIndexingEnabled() {
  return (
    localSourcesEnabled() &&
    String(process.env.WICI_LOCAL_ON_DEMAND_ENABLED ?? "true") !== "false"
  );
}

function readJson(filepath, fallback) {
  try {
    if (!fs.existsSync(filepath)) return fallback;
    return JSON.parse(fs.readFileSync(filepath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filepath, data) {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function readState(workspaceSlug) {
  const state = readJson(statePath(workspaceSlug), { version: 1, files: {} });
  if (!state.files || typeof state.files !== "object") state.files = {};
  return state;
}

function writeState(workspaceSlug, state) {
  writeJson(statePath(workspaceSlug), state);
}

function parseExtensions(extensions) {
  if (!extensions) return new Set(DEFAULT_EXTENSIONS);
  const raw = Array.isArray(extensions)
    ? extensions
    : String(extensions).split(",");
  const parsed = raw
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .map((value) => (value.startsWith(".") ? value : `.${value}`));
  return new Set(parsed.length > 0 ? parsed : DEFAULT_EXTENSIONS);
}

function defaultUserRoots({ includePictures = false } = {}) {
  const home = os.homedir();
  const roots = [
    path.join(home, "Documents"),
    path.join(home, "Downloads"),
    path.join(home, "Desktop"),
  ];
  if (includePictures) roots.push(path.join(home, "Pictures"));
  return roots;
}

function expandRoot(root) {
  const input = String(root || "").trim();
  if (!input) return null;
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function normalizeOptions(options = {}) {
  const roots = (options.roots || [])
    .map(expandRoot)
    .filter(Boolean)
    .map((root) => path.resolve(root));

  return {
    roots: prioritizedScanRoots(roots),
    extensions: parseExtensions(options.extensions),
    maxBytes: Number(options.maxBytes || 50 * 1024 * 1024),
    includeHidden:
      options.includeHidden === true ||
      String(process.env.WICI_LOCAL_SOURCES_INCLUDE_HIDDEN ?? "false") ===
        "true",
    limit:
      options.limit === null || options.limit === undefined
        ? null
        : Math.max(0, Number(options.limit)),
    force: !!options.force,
    maxScanFiles: Math.max(
      1,
      Number(
        options.maxScanFiles ||
          process.env.WICI_LOCAL_SOURCES_MAX_SCAN_FILES ||
          20_000
      )
    ),
    maxVisitedEntries: Math.max(
      1,
      Number(
        options.maxVisitedEntries ||
          process.env.WICI_LOCAL_SOURCES_MAX_VISITED_ENTRIES ||
          200_000
      )
    ),
  };
}

function normalizeText(value = "") {
  return String(value)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function queryTerms(query = "") {
  const normalized = normalizeText(query);
  const terms = new Set();
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9._-]{1,}/g))
    terms.add(match[0]);
  for (const match of normalized.matchAll(/[\u4e00-\u9fff]{2,}/g))
    terms.add(match[0]);
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

function expandedQueryTerms(query = "") {
  const normalized = normalizeText(query);
  const terms = new Set(queryTerms(query));
  const add = (...values) => values.forEach((value) => terms.add(value));
  const negatesVisual =
    /(别|不要|不是|别沿用|别用|排除|not|don't|do not).{0,20}(视觉|视图|图像|图片|vision|visual|visrag|multi-?modal)/i.test(
      normalized
    );
  const negatesSelf =
    /(别|不要|不是|别沿用|别用|排除|not|don't|do not).{0,20}(self|self-?rag|自我|反思|reflection)/i.test(
      normalized
    );

  if (/(问题|query).*(难度|复杂度|complexity)/i.test(normalized))
    add("adaptive-rag", "query complexity", "complexity", "classifier");
  if (/(按|根据).*(难度|复杂度).*(策略|选择|选)/i.test(normalized))
    add("adaptive-rag", "strategy", "single-step", "multi-step");
  if (/(难度|复杂度).*(策略|分流|选择|选)/i.test(normalized))
    add("adaptive-rag", "strategy", "query complexity");
  if (
    !negatesVisual &&
    /(视觉|视图|图像|图片|vision|visual|visrag|multi-?modal)/i.test(normalized)
  )
    add(
      "visrag",
      "vision-based",
      "multi-modality",
      "document image",
      "vlm",
      "textrag"
    );
  if (
    !negatesSelf &&
    /(self-?rag|\bself\b.*(rag|开头|论文|paper)|自我|反思|reflection|批判|critique)/i.test(
      normalized
    )
  )
    add("self-rag", "reflection tokens", "isrel", "issup", "isuse");

  return Array.from(terms);
}

function numericQueryTerms(query = "") {
  return expandedQueryTerms(query).filter((term) => /^\d{3,}/.test(term));
}

function highSignalQueryTerms(terms = []) {
  const generic = new Set([
    "query",
    "complexity",
    "rag",
    "figure",
    "table",
    "paper",
    "pdf",
    "local",
    "document",
    "论文",
    "文档",
    "图表",
    "图片",
  ]);
  return terms.filter((term) => {
    const normalized = normalizeText(term);
    if (/^\d{3,}/.test(normalized)) return true;
    if (generic.has(normalized)) return false;
    return /^[a-z0-9][a-z0-9._-]{3,}$/i.test(normalized);
  });
}

function queryIntent(query = "") {
  const normalized = normalizeText(query);
  const wantsImage =
    /(image|photo|picture|screenshot|jpeg|jpg|png|照片|图片|截图|相册)/i.test(
      normalized
    );
  const wantsPaper = /(pdf|paper|论文|文献|arxiv|publication|whitepaper)/i.test(
    normalized
  );
  const wantsCode =
    /(code|repo|repository|source|readme|markdown|md|json|csv|代码|源码|仓库|项目|配置)/i.test(
      normalized
    );
  const wantsDocument =
    wantsImage === false ||
    /(pdf|paper|document|docx|xlsx|csv|txt|md|论文|文档|文件|报告|表格|下载)/i.test(
      normalized
    );
  return { wantsCode, wantsDocument, wantsImage, wantsPaper };
}

function shouldRunOnDemandForQuery(query = "", chatMode = "automatic") {
  if (!onDemandIndexingEnabled()) return false;
  if (chatMode === "chat") return false;
  const normalized = normalizeText(query);
  return /(local|file|files|pdf|paper|document|download|find|search|rag|visrag|self|self-?rag|adaptive-rag|reflection|本地|文件|文档|论文|下载|找|搜|照片|图片|截图|视觉|自我|反思|检索|新检索|重新检索|全局检索|全盘检索|换一篇|另一篇|另一个|不是这篇)/i.test(
    normalized
  );
}

function prioritizedScanRoots(roots = []) {
  const home = os.homedir();
  const prioritized = [];
  const seen = new Set();

  function add(root) {
    const resolved = path.resolve(root);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    prioritized.push(resolved);
  }

  function addUserRoots() {
    for (const name of USER_ROOT_PRIORITY) add(path.join(home, name));
  }

  for (const root of roots) {
    if (root === "/" || root === home) addUserRoots();
    add(root);
  }

  return prioritized;
}

function shouldSkipDir(name, includeHidden = false) {
  if (SKIP_DIR_NAMES.has(name)) return true;
  if (!includeHidden && name.startsWith(".")) return true;
  if (name.endsWith(".app")) return true;
  if (name.endsWith(".framework")) return true;
  if (name.endsWith(".xcodeproj")) return true;
  return false;
}

function fingerprintFor(filepath, stat) {
  const absolutePath = path.resolve(filepath);
  return {
    path: absolutePath,
    key: absolutePath,
    size: stat.size,
    mtimeMs: Math.floor(stat.mtimeMs),
    signature: `${stat.size}:${Math.floor(stat.mtimeMs)}`,
    extension: path.extname(absolutePath).toLowerCase(),
  };
}

function filePriority(fingerprint) {
  const extensionPriority =
    EXTENSION_PRIORITY[fingerprint.extension] ?? Number.MAX_SAFE_INTEGER;
  return [
    extensionPriority,
    -Number(fingerprint.mtimeMs || 0),
    fingerprint.path.length,
    fingerprint.key,
  ];
}

function compareFingerprints(a, b) {
  const aPriority = filePriority(a);
  const bPriority = filePriority(b);
  for (let index = 0; index < aPriority.length; index++) {
    if (aPriority[index] < bPriority[index]) return -1;
    if (aPriority[index] > bPriority[index]) return 1;
  }
  return 0;
}

function scoreFingerprintForQuery(fingerprint, query = "") {
  const terms = queryTerms(query);
  const { wantsCode, wantsDocument, wantsImage, wantsPaper } =
    queryIntent(query);
  const name = normalizeText(path.basename(fingerprint.path));
  const fullPath = normalizeText(fingerprint.path);
  const extension = fingerprint.extension;
  const numericTerms = numericQueryTerms(query);
  let score = 0;
  const hasTermMatch = terms.some((term) => {
    const normalizedTerm = normalizeText(term);
    return (
      normalizedTerm.length >= 2 &&
      (name.includes(normalizedTerm) || fullPath.includes(normalizedTerm))
    );
  });

  if (!wantsImage && DEFAULT_ON_DEMAND_IMAGE_EXTENSIONS.includes(extension))
    return 0;
  if (
    numericTerms.length > 0 &&
    !numericTerms.every((term) => fullPath.includes(normalizeText(term)))
  )
    return 0;
  if (fullPath.includes(".photoslibrary/") && !wantsImage) return 0;
  if (wantsPaper && extension !== ".pdf" && !hasTermMatch) return 0;
  if (CODE_OR_DATA_EXTENSIONS.has(extension) && !wantsCode && !hasTermMatch)
    return 0;

  if (
    wantsDocument &&
    DEFAULT_ON_DEMAND_DOCUMENT_EXTENSIONS.includes(extension)
  )
    score += 20;
  if (wantsImage && DEFAULT_ON_DEMAND_IMAGE_EXTENSIONS.includes(extension))
    score += 20;
  if (wantsPaper && extension === ".pdf") score += 30;
  if (/spreadsheet|sheet|excel|表格/i.test(query) && extension === ".xlsx")
    score += 20;

  for (const term of terms) {
    if (name.includes(term)) score += 15;
    else if (fullPath.includes(term)) score += 5;
  }

  const ageHours = Math.max(
    0,
    (Date.now() - Number(fingerprint.mtimeMs || 0)) / 3_600_000
  );
  score += Math.max(0, 10 - Math.log10(ageHours + 1) * 2);

  if (fullPath.includes("/documents/")) score += 6;
  if (fullPath.includes("/downloads/")) score += 5;
  if (fullPath.includes("/desktop/")) score += 4;
  if (fullPath.includes("/pictures/")) score += wantsImage ? 3 : -8;
  if (fullPath.includes(".photoslibrary/")) score += wantsImage ? -2 : -30;

  return score;
}

function stateStrongMatchesForQuery(state, query = "") {
  const terms = expandedQueryTerms(query).filter(
    (term) => /^\d{3,}/.test(term) || normalizeText(term).length >= 5
  );
  if (terms.length === 0) return [];
  const numericTerms = numericQueryTerms(query);
  const highSignalTerms = highSignalQueryTerms(terms);

  const matches = [];
  for (const [key, row] of Object.entries(state?.files || {})) {
    const documents = Array.isArray(row?.documents) ? row.documents : [];
    for (const document of documents) {
      const identityText = normalizeText(
        [key, document?.title, document?.chunkSource, document?.description]
          .filter(Boolean)
          .join("\n")
      );
      const contentText = normalizeText(
        String(document?.pageContent || "").slice(0, 50_000)
      );
      const numericIdentityMatches = numericTerms.filter((term) =>
        identityText.includes(normalizeText(term))
      );
      if (
        numericTerms.length > 0 &&
        numericIdentityMatches.length !== numericTerms.length
      )
        continue;

      const matchedTerms = terms.filter((term) => {
        const normalizedTerm = normalizeText(term);
        if (/^\d{3,}/.test(term)) return identityText.includes(normalizedTerm);
        return (
          identityText.includes(normalizedTerm) ||
          contentText.includes(normalizedTerm)
        );
      });
      if (matchedTerms.length === 0) continue;
      if (
        highSignalTerms.length > 0 &&
        !matchedTerms.some((term) =>
          highSignalTerms.includes(normalizeText(term))
        )
      )
        continue;

      const score = matchedTerms.reduce((total, term) => {
        const normalizedTerm = normalizeText(term);
        if (/^\d{3,}/.test(normalizedTerm)) return total + 100;
        if (highSignalTerms.includes(normalizedTerm)) return total + 80;
        if (/^[a-z0-9][a-z0-9._-]{3,}$/i.test(normalizedTerm))
          return total + 12;
        return total + 6;
      }, 0);

      matches.push({
        title: document?.title || path.basename(key),
        location: document?.location,
        chunkSource: document?.chunkSource,
        sourcePath: key,
        docSource: document?.docSource,
        score,
        wiciLocalSourceMatch: true,
        wiciLocalMatchedTerms: matchedTerms,
      });
    }
  }

  const seen = new Set();
  const sorted = matches
    .filter((match) => match.location)
    .sort((a, b) => b.score - a.score)
    .filter((match) => {
      if (seen.has(match.location)) return false;
      seen.add(match.location);
      return true;
    });

  const [top, next] = sorted;
  if (top?.score >= 160 && (!next || next.score < top.score * 0.6))
    return [top];

  return sorted.slice(0, 5);
}

function rankedCandidatesForQuery({ files = [], state, force, query = "" }) {
  return candidatesFor(files, state, force)
    .map((fingerprint) => ({
      fingerprint,
      score: scoreFingerprintForQuery(fingerprint, query),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return compareFingerprints(a.fingerprint, b.fingerprint);
    })
    .map(({ fingerprint, score }) => ({ ...fingerprint, score }));
}

function scanLocalFiles(options = {}) {
  const parsed = normalizeOptions(options);
  const files = [];
  const skipped = [];
  const seenDirs = new Set();
  const seenFiles = new Set();
  let truncated = false;
  let visitedEntries = 0;

  function shouldStop() {
    return (
      truncated ||
      files.length >= parsed.maxScanFiles ||
      visitedEntries >= parsed.maxVisitedEntries
    );
  }

  function considerFile(filepath) {
    if (shouldStop()) return;
    const resolved = path.resolve(filepath);
    if (seenFiles.has(resolved)) return;
    seenFiles.add(resolved);
    visitedEntries += 1;
    try {
      const stat = fs.lstatSync(resolved);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) return;
      const extension = path.extname(resolved).toLowerCase();
      if (!parsed.extensions.has(extension)) return;
      if (parsed.maxBytes > 0 && stat.size > parsed.maxBytes) {
        skipped.push({ path: resolved, reason: "too_large", size: stat.size });
        return;
      }
      files.push(fingerprintFor(resolved, stat));
      if (shouldStop()) truncated = true;
    } catch (error) {
      skipped.push({ path: resolved, reason: error.code || error.message });
    }
  }

  function entryPriority(entry) {
    if (entry.isDirectory()) {
      const userRootIndex = USER_ROOT_PRIORITY.indexOf(entry.name);
      return [
        0,
        userRootIndex === -1 ? USER_ROOT_PRIORITY.length : userRootIndex,
        entry.name,
      ];
    }

    if (entry.isFile()) {
      const extension = path.extname(entry.name).toLowerCase();
      return [
        1,
        EXTENSION_PRIORITY[extension] ?? Number.MAX_SAFE_INTEGER,
        entry.name,
      ];
    }

    return [2, Number.MAX_SAFE_INTEGER, entry.name];
  }

  function sortEntries(entries) {
    return entries.sort((a, b) => {
      const aPriority = entryPriority(a);
      const bPriority = entryPriority(b);
      for (let index = 0; index < aPriority.length; index++) {
        if (aPriority[index] < bPriority[index]) return -1;
        if (aPriority[index] > bPriority[index]) return 1;
      }
      return 0;
    });
  }

  function walk(root) {
    if (shouldStop()) return;
    const resolvedRoot = path.resolve(root);
    if (seenDirs.has(resolvedRoot)) return;
    seenDirs.add(resolvedRoot);
    visitedEntries += 1;
    try {
      const stat = fs.lstatSync(resolvedRoot);
      if (stat.isSymbolicLink()) return;
      if (stat.isFile()) return considerFile(resolvedRoot);
      if (!stat.isDirectory()) return;

      const entries = sortEntries(
        fs.readdirSync(resolvedRoot, { withFileTypes: true })
      );
      for (const entry of entries) {
        if (shouldStop()) {
          truncated = true;
          return;
        }
        if (shouldSkipDir(entry.name, parsed.includeHidden)) continue;
        const nextPath = path.join(resolvedRoot, entry.name);
        if (entry.isDirectory()) walk(nextPath);
        else if (entry.isFile()) considerFile(nextPath);
      }
    } catch (error) {
      skipped.push({ path: root, reason: error.code || error.message });
    }
  }

  for (const root of parsed.roots) {
    if (shouldStop()) break;
    if (!fs.existsSync(root)) {
      skipped.push({ path: root, reason: "missing" });
      continue;
    }
    walk(root);
  }

  files.sort(compareFingerprints);
  return {
    files,
    skipped,
    truncated,
    roots: parsed.roots,
    extensions: Array.from(parsed.extensions).sort(),
    limits: {
      maxBytes: parsed.maxBytes,
      maxScanFiles: parsed.maxScanFiles,
      maxVisitedEntries: parsed.maxVisitedEntries,
    },
  };
}

function candidatesFor(files, state, force) {
  return files.filter((fingerprint) => {
    if (force) return true;
    const row = state.files[fingerprint.key];
    return !row || row.signature !== fingerprint.signature;
  });
}

function summarizeState(workspaceSlug) {
  const state = readState(workspaceSlug);
  const rows = Object.values(state.files || {});
  return {
    statePath: statePath(workspaceSlug),
    indexedFiles: rows.length,
    lastIndexedAt:
      rows
        .map((row) => row.indexedAt)
        .filter(Boolean)
        .sort()
        .pop() || null,
  };
}

function pathPresets() {
  const home = os.homedir();
  return [
    {
      label: "User files",
      path: "~/Documents\n~/Downloads\n~/Desktop\n~/Pictures",
      description: "Documents, Downloads, Desktop, and Pictures",
    },
    { label: "Home", path: "~", description: home },
    {
      label: "Desktop",
      path: "~/Desktop",
      description: path.join(home, "Desktop"),
    },
    {
      label: "Documents",
      path: "~/Documents",
      description: path.join(home, "Documents"),
    },
    {
      label: "Pictures",
      path: "~/Pictures",
      description: path.join(home, "Pictures"),
    },
    {
      label: "Downloads",
      path: "~/Downloads",
      description: path.join(home, "Downloads"),
    },
    {
      label: "Full disk",
      path: "/",
      description: "Advanced; skips system folders",
    },
  ];
}

function previewLocalSource(workspaceSlug, options = {}) {
  const state = readState(workspaceSlug);
  const parsed = normalizeOptions(options);
  const scan = scanLocalFiles(options);
  const allCandidates = candidatesFor(scan.files, state, parsed.force);
  const candidates =
    parsed.limit === null
      ? allCandidates
      : allCandidates.slice(0, parsed.limit);

  return {
    success: true,
    enabled: localSourcesEnabled(),
    roots: scan.roots,
    extensions: scan.extensions,
    truncated: scan.truncated,
    skipped: scan.skipped.slice(0, 50),
    summary: {
      seen: scan.files.length,
      changedOrNew: allCandidates.length,
      unchanged: scan.files.length - allCandidates.length,
      toIndex: candidates.length,
    },
    candidates: candidates.slice(0, 100).map((item) => ({
      path: item.path,
      size: item.size,
      signature: item.signature,
      extension: item.extension,
    })),
  };
}

function activeJobForWorkspace(workspaceSlug) {
  return Array.from(jobs.values()).find(
    (job) =>
      job.workspaceSlug === workspaceSlug &&
      ["queued", "running"].includes(job.status)
  );
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    workspaceSlug: job.workspaceSlug,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    current: job.current,
    roots: job.roots,
    truncated: job.truncated,
    summary: job.summary,
    rows: job.rows.slice(-100),
    error: job.error,
  };
}

function uploadFilenameFor(fingerprint) {
  const ext = path.extname(fingerprint.path);
  const digest = crypto
    .createHash("sha1")
    .update(`${fingerprint.key}:${fingerprint.signature}`)
    .digest("hex")
    .slice(0, 12);
  const rawBase = path.basename(fingerprint.path, ext) || "local-file";
  const base =
    sanitizeFileName(rawBase).replace(/\s+/g, "-").slice(0, 90) || "local-file";
  return `${base}-${digest}${ext}`;
}

async function removePreviousWorkspaceDocs(workspace, stateRow, userId) {
  const oldLocations = (stateRow?.documents || [])
    .map((doc) => (typeof doc === "string" ? doc : doc?.location))
    .filter(Boolean);
  if (oldLocations.length === 0) return;
  await Document.removeDocuments(workspace, oldLocations, userId);
}

async function processFingerprint({
  collector,
  workspace,
  fingerprint,
  state,
  userId,
}) {
  const started = Date.now();
  const timings = {
    copyMs: 0,
    collectorMs: 0,
    removePreviousMs: 0,
    embedMs: 0,
    totalMs: 0,
  };
  fs.mkdirSync(hotdirPath, { recursive: true });
  const uploadName = uploadFilenameFor(fingerprint);
  const destination = path.resolve(hotdirPath, uploadName);
  if (!isWithin(hotdirPath, destination))
    throw new Error("Invalid hotdir path.");

  const copyStarted = Date.now();
  fs.copyFileSync(fingerprint.path, destination);
  timings.copyMs = Date.now() - copyStarted;

  const metadata = {
    title: path.basename(fingerprint.path),
    docAuthor: "local filesystem",
    description: `Auto-indexed from local path: ${fingerprint.path}`,
    docSource: "WICI local folder source",
    chunkSource: `file://${fingerprint.path}`,
    sourcePath: fingerprint.path,
    wiciLocalSource: true,
  };
  const collectorStarted = Date.now();
  const result = await collector.processDocument(uploadName, metadata);
  timings.collectorMs = Date.now() - collectorStarted;
  if (!result?.success || !result.documents?.length) {
    throw new Error(result?.reason || "Collector failed to process document.");
  }

  const removeStarted = Date.now();
  await removePreviousWorkspaceDocs(
    workspace,
    state.files[fingerprint.key],
    userId
  );
  timings.removePreviousMs = Date.now() - removeStarted;

  const locations = result.documents
    .map((document) => document.location)
    .filter(Boolean);
  const embedStarted = Date.now();
  const { failedToEmbed = [], errors = [] } = await Document.addDocuments(
    workspace,
    locations,
    userId
  );
  timings.embedMs = Date.now() - embedStarted;
  if (failedToEmbed.length > 0) {
    throw new Error(
      errors?.[0] || `Failed to embed ${failedToEmbed.join(", ")}`
    );
  }

  state.files[fingerprint.key] = {
    signature: fingerprint.signature,
    size: fingerprint.size,
    workspace: workspace.slug,
    documents: result.documents,
    indexedAt: new Date().toISOString(),
  };
  timings.totalMs = Date.now() - started;
  return { documents: result.documents, timings };
}

async function runIndexJob(job, { workspace, userId, options }) {
  const started = Date.now();
  const state = readState(workspace.slug);
  const parsed = normalizeOptions(options);
  const collector = new CollectorApi();

  job.status = "running";
  job.summary = {
    seen: 0,
    changedOrNew: 0,
    unchanged: 0,
    attempted: 0,
    ok: 0,
    failed: 0,
    scanElapsedMs: 0,
    indexElapsedMs: 0,
    elapsedMs: 0,
  };

  if (!(await collector.online())) {
    throw new Error("Document processing API is not online.");
  }

  const scanStarted = Date.now();
  const scan = scanLocalFiles(options);
  job.summary.scanElapsedMs = Date.now() - scanStarted;
  const indexStarted = Date.now();
  const allCandidates = candidatesFor(scan.files, state, parsed.force);
  const candidates =
    parsed.limit === null
      ? allCandidates
      : allCandidates.slice(0, parsed.limit);

  job.roots = scan.roots;
  job.truncated = scan.truncated;
  job.summary.seen = scan.files.length;
  job.summary.changedOrNew = allCandidates.length;
  job.summary.unchanged = scan.files.length - allCandidates.length;
  job.summary.attempted = candidates.length;

  for (const [index, fingerprint] of candidates.entries()) {
    job.current = {
      index: index + 1,
      total: candidates.length,
      path: fingerprint.path,
    };
    const row = {
      path: fingerprint.path,
      size: fingerprint.size,
      ok: false,
      error: null,
      documents: [],
      timings: null,
      elapsedMs: 0,
    };

    try {
      const rowStarted = Date.now();
      const result = await processFingerprint({
        collector,
        workspace,
        fingerprint,
        state,
        userId,
      });
      row.documents = result.documents;
      row.timings = result.timings;
      row.elapsedMs = Date.now() - rowStarted;
      row.ok = true;
      job.summary.ok += 1;
      writeState(workspace.slug, state);
    } catch (error) {
      row.error = error.message;
      job.summary.failed += 1;
    }

    job.rows.push(row);
    job.summary.indexElapsedMs = Date.now() - indexStarted;
    job.summary.elapsedMs = Date.now() - started;
  }

  job.current = null;
  job.status = "complete";
  job.finishedAt = new Date().toISOString();
  job.summary.indexElapsedMs = Date.now() - indexStarted;
  job.summary.elapsedMs = Date.now() - started;
}

async function maybeIndexLocalSourcesForQuery({
  workspace,
  userId = null,
  query = "",
  chatMode = "automatic",
} = {}) {
  const started = Date.now();
  const numericTerms = numericQueryTerms(query);
  if (!workspace?.slug || !shouldRunOnDemandForQuery(query, chatMode)) {
    return { indexed: 0, attempted: 0, skipped: true, reason: "not_triggered" };
  }
  if (activeJobForWorkspace(workspace.slug)) {
    return { indexed: 0, attempted: 0, skipped: true, reason: "job_running" };
  }

  const intent = queryIntent(query);
  const roots = defaultUserRoots({ includePictures: intent.wantsImage });
  const extensions = [
    ...DEFAULT_ON_DEMAND_DOCUMENT_EXTENSIONS,
    ...(intent.wantsImage ? DEFAULT_ON_DEMAND_IMAGE_EXTENSIONS : []),
  ];
  const options = {
    roots,
    extensions,
    maxBytes:
      Number(process.env.WICI_LOCAL_ON_DEMAND_MAX_BYTES || 75) * 1024 * 1024,
    maxScanFiles: Number(
      process.env.WICI_LOCAL_ON_DEMAND_MAX_SCAN_FILES || 5_000
    ),
    maxVisitedEntries: Number(
      process.env.WICI_LOCAL_ON_DEMAND_MAX_VISITED_ENTRIES || 25_000
    ),
    force: false,
  };
  const state = readState(workspace.slug);
  const strongMatches = stateStrongMatchesForQuery(state, query);
  if (strongMatches.length > 0) {
    return {
      indexed: 0,
      attempted: 0,
      skipped: true,
      reason: "indexed_candidate_exists",
      matchedDocuments: strongMatches,
      elapsedMs: Date.now() - started,
    };
  }

  const scanStarted = Date.now();
  const scan = scanLocalFiles(options);
  const scanElapsedMs = Date.now() - scanStarted;
  const ranked = rankedCandidatesForQuery({
    files: scan.files,
    state,
    force: false,
    query,
  });
  const maxDocs = Math.max(
    0,
    Number(
      intent.wantsImage
        ? process.env.WICI_LOCAL_ON_DEMAND_IMAGE_LIMIT || 1
        : process.env.WICI_LOCAL_ON_DEMAND_DOCUMENT_LIMIT || 3
    )
  );
  const candidates = ranked.slice(0, maxDocs);
  if (candidates.length === 0) {
    return {
      indexed: 0,
      attempted: 0,
      skipped: true,
      reason: "no_candidates",
      strictLocalMiss: numericTerms.length > 0,
      numericTerms,
      elapsedMs: Date.now() - started,
      scan: {
        seen: scan.files.length,
        truncated: scan.truncated,
        roots: scan.roots,
        elapsedMs: scanElapsedMs,
      },
    };
  }

  const collector = new CollectorApi();
  if (!(await collector.online())) {
    return {
      indexed: 0,
      attempted: candidates.length,
      skipped: true,
      reason: "collector_offline",
      elapsedMs: Date.now() - started,
    };
  }

  const rows = [];
  let indexed = 0;
  for (const fingerprint of candidates) {
    const row = {
      path: fingerprint.path,
      extension: fingerprint.extension,
      score: fingerprint.score,
      ok: false,
      error: null,
      documents: [],
      timings: null,
      elapsedMs: 0,
    };
    try {
      const rowStarted = Date.now();
      const result = await processFingerprint({
        collector,
        workspace,
        fingerprint,
        state,
        userId,
      });
      row.documents = result.documents;
      row.timings = result.timings;
      row.elapsedMs = Date.now() - rowStarted;
      row.ok = true;
      indexed += 1;
      writeState(workspace.slug, state);
    } catch (error) {
      row.error = error.message;
    }
    rows.push(row);
  }

  return {
    indexed,
    attempted: candidates.length,
    skipped: false,
    reason: null,
    elapsedMs: Date.now() - started,
    scan: {
      seen: scan.files.length,
      truncated: scan.truncated,
      roots: scan.roots,
      elapsedMs: scanElapsedMs,
    },
    rows,
  };
}

function startLocalSourceIndexJob({ workspace, userId, options = {} }) {
  const runningJob = activeJobForWorkspace(workspace.slug);
  if (runningJob)
    return {
      success: false,
      error: "A local source job is already running.",
      job: publicJob(runningJob),
    };

  const job = {
    id: crypto.randomUUID(),
    workspaceSlug: workspace.slug,
    status: "queued",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    current: null,
    roots: [],
    truncated: false,
    summary: {},
    rows: [],
    error: null,
  };
  jobs.set(job.id, job);

  setImmediate(() => {
    runIndexJob(job, { workspace, userId, options }).catch((error) => {
      job.status = "failed";
      job.error = error.message;
      job.finishedAt = new Date().toISOString();
    });
  });

  return { success: true, error: null, job: publicJob(job) };
}

function getLocalSourceJob(jobId) {
  return publicJob(jobs.get(jobId));
}

function getWorkspaceLocalSourceInfo(workspaceSlug) {
  return {
    enabled: localSourcesEnabled(),
    presets: pathPresets(),
    defaults: {
      extensions: DEFAULT_EXTENSIONS,
      maxBytes: 50 * 1024 * 1024,
      limit: 100,
    },
    state: summarizeState(workspaceSlug),
    activeJob: publicJob(activeJobForWorkspace(workspaceSlug)),
  };
}

module.exports = {
  getLocalSourceJob,
  getWorkspaceLocalSourceInfo,
  localSourcesEnabled,
  maybeIndexLocalSourcesForQuery,
  previewLocalSource,
  startLocalSourceIndexJob,
};
