#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DEFAULT_BASE_URL = "http://127.0.0.1:3101/api";
const DEFAULT_WORKSPACE = "wici-local-folder-memory";
const DEFAULT_REPORT = path.resolve(
  __dirname,
  "../reports/m9-full-disk-index/full_disk_index_audit.json"
);

function parseLimit(value) {
  if (value === null || value === undefined || value === "") return 200;
  const normalized = String(value).trim().toLowerCase();
  if (["all", "none", "null", "unlimited"].includes(normalized)) return null;
  const number = Number(normalized);
  if (!Number.isFinite(number) || number < 0)
    throw new Error(`Invalid --limit value: ${value}`);
  return number;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    baseUrl: process.env.WICI_AUDIT_BASE_URL || DEFAULT_BASE_URL,
    workspace: process.env.WICI_AUDIT_WORKSPACE || DEFAULT_WORKSPACE,
    roots: ["~"],
    extensions: [".pdf", ".png", ".jpg", ".jpeg", ".webp", ".txt", ".md", ".docx", ".xlsx"],
    limit: parseLimit(process.env.WICI_AUDIT_LIMIT || 200),
    maxBytes: Number(process.env.WICI_AUDIT_MAX_BYTES || 75) * 1024 * 1024,
    maxScanFiles: Number(process.env.WICI_AUDIT_MAX_SCAN_FILES || 50_000),
    maxVisitedEntries: Number(
      process.env.WICI_AUDIT_MAX_VISITED_ENTRIES || 250_000
    ),
    force: process.env.WICI_AUDIT_FORCE === "true",
    report: process.env.WICI_AUDIT_REPORT || DEFAULT_REPORT,
    pollMs: Number(process.env.WICI_AUDIT_POLL_MS || 2_000),
    timeoutMs: Number(process.env.WICI_AUDIT_TIMEOUT_MS || 3_600_000),
    dryRun: false,
    printJson: process.env.WICI_AUDIT_PRINT_JSON === "true",
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === "--base-url") args.baseUrl = next();
    else if (arg === "--workspace") args.workspace = next();
    else if (arg === "--roots") args.roots = next().split(",").filter(Boolean);
    else if (arg === "--extensions")
      args.extensions = next().split(",").filter(Boolean);
    else if (arg === "--limit") args.limit = parseLimit(next());
    else if (arg === "--max-mb") args.maxBytes = Number(next()) * 1024 * 1024;
    else if (arg === "--max-scan-files") args.maxScanFiles = Number(next());
    else if (arg === "--max-visited") args.maxVisitedEntries = Number(next());
    else if (arg === "--force") args.force = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--report") args.report = next();
    else if (arg === "--poll-ms") args.pollMs = Number(next());
    else if (arg === "--timeout-ms") args.timeoutMs = Number(next());
    else if (arg === "--print-json") args.printJson = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 500)}`);
  return parsed;
}

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 500)}`);
  return parsed;
}

function jobUrl(args, jobId) {
  return `${args.baseUrl}/workspace/${encodeURIComponent(
    args.workspace
  )}/local-sources/job/${encodeURIComponent(jobId)}`;
}

function sourceOptions(args) {
  return {
    roots: args.roots,
    extensions: args.extensions,
    limit: args.limit,
    force: args.force,
    maxBytes: args.maxBytes,
    maxScanFiles: args.maxScanFiles,
    maxVisitedEntries: args.maxVisitedEntries,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollJob(args, jobId) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < args.timeoutMs) {
    const payload = await getJson(jobUrl(args, jobId));
    last = payload.job;
    const summary = last?.summary || {};
    process.stderr.write(
      `\rstatus=${last?.status} attempted=${summary.attempted || 0} ok=${
        summary.ok || 0
      } failed=${summary.failed || 0} elapsed=${summary.elapsedMs || 0}ms`
    );
    if (["complete", "failed"].includes(last?.status)) {
      process.stderr.write("\n");
      return last;
    }
    await sleep(args.pollMs);
  }
  throw new Error(`Timed out waiting for local-source job ${jobId}`);
}

async function main() {
  const args = parseArgs();
  const options = sourceOptions(args);
  const started = Date.now();

  const previewStarted = Date.now();
  const preview = await postJson(
    `${args.baseUrl}/workspace/${encodeURIComponent(
      args.workspace
    )}/local-sources/preview`,
    options
  );
  const previewMs = Date.now() - previewStarted;

  let job = null;
  if (!args.dryRun) {
    const startStarted = Date.now();
    const start = await postJson(
      `${args.baseUrl}/workspace/${encodeURIComponent(
        args.workspace
      )}/local-sources/index`,
      options
    );
    if (!start.success) throw new Error(start.error || "Index job failed to start");
    job = await pollJob(args, start.job.id);
    job.startRequestMs = Date.now() - startStarted;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: args.baseUrl,
    workspace: args.workspace,
    options,
    previewMs,
    elapsedMs: Date.now() - started,
    preview,
    job,
  };

  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (args.printJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      JSON.stringify(
        {
          generatedAt: report.generatedAt,
          workspace: report.workspace,
          options: report.options,
          previewMs: report.previewMs,
          elapsedMs: report.elapsedMs,
          previewSummary: report.preview?.summary || null,
          jobSummary: report.job?.summary || null,
          jobStatus: report.job?.status || null,
        },
        null,
        2
      )
    );
  }
  console.error(`wrote ${args.report}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
