#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DEFAULT_BASE_URL = "http://127.0.0.1:3101/api";
const DEFAULT_WORKSPACE = "wici-local-folder-memory";
const DEFAULT_REPORT = path.resolve(
  __dirname,
  "../reports/m9-full-disk-index/local_search_probe.json"
);

const DEFAULT_PROMPTS = [
  "我本地那篇讲“按问题难度选策略”的 RAG 论文，核心想法是什么？",
  "那篇 Adaptive-RAG 论文的 Figure 1 横轴和纵轴分别是什么？",
  "我下载的那篇视觉版 RAG 论文，为什么说传统 TextRAG 会丢信息？",
  "那篇视觉 RAG 的 Figure 1 有哪些数字？",
  "本地有没有相机旁边放着手机的图片？",
  "有没有一张图是黑猫在洗手台或浴室附近？",
  "帮我找那个盖了章的文件。",
  "本机有没有空白文件？",
];

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    baseUrl: process.env.WICI_PROBE_BASE_URL || DEFAULT_BASE_URL,
    workspace: process.env.WICI_PROBE_WORKSPACE || DEFAULT_WORKSPACE,
    report: process.env.WICI_PROBE_REPORT || DEFAULT_REPORT,
    timeoutMs: Number(process.env.WICI_PROBE_TIMEOUT_MS || 180_000),
    prompts: [...DEFAULT_PROMPTS],
    includeEvents: process.env.WICI_PROBE_INCLUDE_EVENTS === "true",
    printJson: process.env.WICI_PROBE_PRINT_JSON === "true",
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === "--base-url") args.baseUrl = next();
    else if (arg === "--workspace") args.workspace = next();
    else if (arg === "--report") args.report = next();
    else if (arg === "--timeout-ms") args.timeoutMs = Number(next());
    else if (arg === "--include-events") args.includeEvents = true;
    else if (arg === "--print-json") args.printJson = true;
    else if (arg === "--prompt") args.prompts.push(next());
    else if (arg === "--prompts") {
      args.prompts = next()
        .split("\n")
        .map((prompt) => prompt.trim())
        .filter(Boolean);
    } else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function parseSseEvents(text = "") {
  const events = [];
  for (const block of String(text).split(/\n\n+/)) {
    const lines = block
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.startsWith("data:"));
    if (lines.length === 0) continue;
    const payload = lines
      .map((line) => line.replace(/^data:\s?/, ""))
      .join("\n")
      .trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      events.push({ type: "parse_error", raw: payload.slice(0, 2_000) });
    }
  }
  return events;
}

function summarizeEvents(events = []) {
  let text = "";
  let final = null;
  let lastWithSources = null;
  let lastWithMetrics = null;
  let lastWithLocalIndex = null;
  for (const event of events) {
    if (event.type === "textResponseChunk") text += event.textResponse || "";
    if (event.type === "textResponse") {
      text = event.textResponse || text;
      final = event;
    }
    if (Array.isArray(event.sources) && event.sources.length > 0)
      lastWithSources = event;
    if (event.metrics) lastWithMetrics = event;
    if (event.wiciLocalIndex) lastWithLocalIndex = event;
    if (event.close) final = event;
  }

  const sources = Array.isArray(final?.sources) && final.sources.length > 0
    ? final.sources
    : Array.isArray(lastWithSources?.sources)
      ? lastWithSources.sources
      : [];
  return {
    type: final?.type || null,
    close: Boolean(final?.close),
    error: final?.error || null,
    text: text.trim(),
    sourceCount: sources.length,
    sources: sources.slice(0, 8).map((source) => ({
      title: source.title || source.name || null,
      location: source.location || null,
      sourcePath: source.sourcePath || source.chunkSource || source.url || null,
      text: String(source.text || source.pageContent || "").slice(0, 500),
    })),
    metrics: final?.metrics || lastWithMetrics?.metrics || {},
    wiciLocalIndex: final?.wiciLocalIndex || lastWithLocalIndex?.wiciLocalIndex || null,
  };
}

async function runPrompt(args, prompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(
      `${args.baseUrl}/workspace/${encodeURIComponent(args.workspace)}/stream-chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: prompt }),
        signal: controller.signal,
      }
    );
    const body = await response.text();
    const events = parseSseEvents(body);
    return {
      prompt,
      ok: response.ok,
      status: response.status,
      elapsedMs: Date.now() - started,
      summary: summarizeEvents(events),
      events,
    };
  } catch (error) {
    return {
      prompt,
      ok: false,
      status: null,
      elapsedMs: Date.now() - started,
      summary: { error: error.message, text: "" },
      events: [],
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const args = parseArgs();
  const started = Date.now();
  const results = [];

  for (const prompt of args.prompts) {
    process.stderr.write(`probe: ${prompt}\n`);
    results.push(await runPrompt(args, prompt));
  }

  const reportResults = args.includeEvents
    ? results
    : results.map(({ events, ...result }) => result);
  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: args.baseUrl,
    workspace: args.workspace,
    elapsedMs: Date.now() - started,
    prompts: args.prompts,
    results: reportResults,
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
          elapsedMs: report.elapsedMs,
          results: report.results.map((result) => ({
            prompt: result.prompt,
            ok: result.ok,
            elapsedMs: result.elapsedMs,
            error: result.summary.error || null,
            sourceCount: result.summary.sourceCount,
            text: result.summary.text.slice(0, 240),
            wiciLocalIndexReason: result.summary.wiciLocalIndex?.reason || null,
          })),
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
