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

function expandRoot(root) {
  const input = String(root || "").trim();
  if (!input) return null;
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function normalizeOptions(options = {}) {
  return {
    roots: (options.roots || [])
      .map(expandRoot)
      .filter(Boolean)
      .map((root) => path.resolve(root)),
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
  return [extensionPriority, fingerprint.path.length, fingerprint.key];
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

function scanLocalFiles(options = {}) {
  const parsed = normalizeOptions(options);
  const files = [];
  const skipped = [];
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
    visitedEntries += 1;
    try {
      const stat = fs.lstatSync(filepath);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) return;
      const extension = path.extname(filepath).toLowerCase();
      if (!parsed.extensions.has(extension)) return;
      if (parsed.maxBytes > 0 && stat.size > parsed.maxBytes) {
        skipped.push({ path: filepath, reason: "too_large", size: stat.size });
        return;
      }
      files.push(fingerprintFor(filepath, stat));
      if (shouldStop()) truncated = true;
    } catch (error) {
      skipped.push({ path: filepath, reason: error.code || error.message });
    }
  }

  function walk(root) {
    if (shouldStop()) return;
    visitedEntries += 1;
    try {
      const stat = fs.lstatSync(root);
      if (stat.isSymbolicLink()) return;
      if (stat.isFile()) return considerFile(root);
      if (!stat.isDirectory()) return;

      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (shouldStop()) {
          truncated = true;
          return;
        }
        if (shouldSkipDir(entry.name, parsed.includeHidden)) continue;
        const nextPath = path.join(root, entry.name);
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
  fs.mkdirSync(hotdirPath, { recursive: true });
  const uploadName = uploadFilenameFor(fingerprint);
  const destination = path.resolve(hotdirPath, uploadName);
  if (!isWithin(hotdirPath, destination))
    throw new Error("Invalid hotdir path.");

  fs.copyFileSync(fingerprint.path, destination);

  const metadata = {
    title: path.basename(fingerprint.path),
    docAuthor: "local filesystem",
    description: `Auto-indexed from local path: ${fingerprint.path}`,
    docSource: "WICI local folder source",
    chunkSource: `file://${fingerprint.path}`,
    sourcePath: fingerprint.path,
    wiciLocalSource: true,
  };
  const result = await collector.processDocument(uploadName, metadata);
  if (!result?.success || !result.documents?.length) {
    throw new Error(result?.reason || "Collector failed to process document.");
  }

  await removePreviousWorkspaceDocs(
    workspace,
    state.files[fingerprint.key],
    userId
  );

  const locations = result.documents
    .map((document) => document.location)
    .filter(Boolean);
  const { failedToEmbed = [], errors = [] } = await Document.addDocuments(
    workspace,
    locations,
    userId
  );
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
  return result.documents;
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
    elapsedMs: 0,
  };

  if (!(await collector.online())) {
    throw new Error("Document processing API is not online.");
  }

  const scan = scanLocalFiles(options);
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
    };

    try {
      row.documents = await processFingerprint({
        collector,
        workspace,
        fingerprint,
        state,
        userId,
      });
      row.ok = true;
      job.summary.ok += 1;
      writeState(workspace.slug, state);
    } catch (error) {
      row.error = error.message;
      job.summary.failed += 1;
    }

    job.rows.push(row);
    job.summary.elapsedMs = Date.now() - started;
  }

  job.current = null;
  job.status = "complete";
  job.finishedAt = new Date().toISOString();
  job.summary.elapsedMs = Date.now() - started;
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
  previewLocalSource,
  startLocalSourceIndexJob,
};
