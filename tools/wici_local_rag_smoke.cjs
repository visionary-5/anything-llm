#!/usr/bin/env node

const { execFileSync } = require("child_process");

const BASE_URL =
  process.env.WICI_SMOKE_BASE_URL || "http://localhost:3101/api";
const WORKSPACE = process.env.WICI_SMOKE_WORKSPACE || "wici-local-folder-memory";
const DB_PATH = process.env.WICI_SMOKE_DB || "server/storage/anythingllm.db";
const MAX_RESPONSE_BYTES = Number(process.env.WICI_SMOKE_MAX_BYTES || 250_000);
const RUN_DISCONNECT = process.argv.includes("--disconnect");
const RUN_ONLY_DISCONNECT = process.argv.includes("--only-disconnect");

function stripHiddenReasoning(text = "") {
  return String(text).replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function parseSse(raw = "") {
  return raw
    .split(/\n\n/)
    .map((event) =>
      event
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n")
    )
    .filter(Boolean)
    .map((payload) => JSON.parse(payload));
}

function sourceTitles(events = []) {
  const titles = new Set();
  for (const event of events) {
    for (const source of event.sources || []) {
      if (source?.title) titles.add(source.title);
    }
  }
  return Array.from(titles);
}

function maxSourceTextLength(events = []) {
  let max = 0;
  for (const event of events) {
    for (const source of event.sources || []) {
      max = Math.max(
        max,
        String(source?.text || source?.pageContent || "").length
      );
    }
  }
  return max;
}

async function postStream(message, { timeoutMs = 180_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${BASE_URL}/workspace/${WORKSPACE}/stream-chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
        signal: controller.signal,
      }
    );
    const raw = await response.text();
    const events = parseSse(raw);
    return {
      raw,
      bytes: Buffer.byteLength(raw),
      events,
      final: events.at(-1),
      text: stripHiddenReasoning(
        events.map((event) => event.textResponse || "").join("")
      ),
      titles: sourceTitles(events),
      maxSourceText: maxSourceTextLength(events),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function assertResult(condition, message) {
  if (!condition) throw new Error(message);
}

async function runCase(test) {
  const result = await postStream(test.message);
  assertResult(
    result.bytes <= MAX_RESPONSE_BYTES,
    `${test.name}: SSE payload too large (${result.bytes} bytes)`
  );
  if (test.title) {
    assertResult(
      result.titles.includes(test.title),
      `${test.name}: expected source title ${test.title}, got ${result.titles.join(", ")}`
    );
  }
  if (test.noSources) {
    assertResult(
      result.titles.length === 0,
      `${test.name}: expected no sources, got ${result.titles.join(", ")}`
    );
  }
  for (const pattern of test.mustMatch || []) {
    assertResult(
      pattern.test(result.text),
      `${test.name}: answer did not match ${pattern}`
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        name: test.name,
        bytes: result.bytes,
        events: result.events.length,
        finalType: result.final?.type,
        chatId: result.final?.chatId || null,
        titles: result.titles,
        maxSourceText: result.maxSourceText,
        answerPreview: result.text.slice(0, 220),
      },
      null,
      2
    )
  );
}

function chatCount() {
  return Number(
    execFileSync("sqlite3", [
      DB_PATH,
      "select count(*) from workspace_chats;",
    ])
      .toString()
      .trim()
  );
}

function findPrompt(marker) {
  return execFileSync("sqlite3", [
    DB_PATH,
    `select id,response from workspace_chats where prompt like '${marker}%' order by id desc limit 1;`,
  ])
    .toString()
    .trim();
}

async function runDisconnectCase() {
  const marker = `DISCONNECT_SMOKE_${Date.now()}`;
  const before = chatCount();
  const controller = new AbortController();
  try {
    const response = await fetch(`${BASE_URL}/workspace/${WORKSPACE}/stream-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `${marker} I have a local PDF starting with 2403 about Adaptive-RAG. Explain in five sentences why it chooses a RAG strategy by question complexity and include the source filename.`,
      }),
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    const started = Date.now();
    while (reader && Date.now() - started < 1_000) {
      const result = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve(null), 100)),
      ]);
      if (result?.done) break;
    }
    controller.abort();
    await reader?.cancel().catch(() => {});
  } catch {}

  await new Promise((resolve) => setTimeout(resolve, 60_000));
  const after = chatCount();
  const row = findPrompt(marker);
  assertResult(after > before, "disconnect: chat count did not increase");
  assertResult(row.includes("2403.14403v2"), "disconnect: response was not saved with the expected source");
  console.log(
    JSON.stringify(
      {
        ok: true,
        name: "disconnect",
        before,
        after,
        rowPreview: row.slice(0, 500),
      },
      null,
      2
    )
  );
}

async function main() {
  const tests = [
    {
      name: "adaptive-exact",
      title: "2403.14403v2.pdf",
      message:
        "我本地有一篇 2403 开头、讲 Adaptive-RAG 的论文，用一句话说它的核心 idea。",
      mustMatch: [/Adaptive-RAG/i, /复杂度|complexity/i],
    },
    {
      name: "adaptive-fuzzy",
      title: "2403.14403v2.pdf",
      message: "我本地有一篇讲 Adaptive-RAG 的论文，它的核心 idea 是什么？",
      mustMatch: [/Adaptive-RAG/i, /复杂度|complexity/i],
    },
    {
      name: "adaptive-followup-categories",
      title: "2403.14403v2.pdf",
      message:
        "那篇 Adaptive-RAG 论文里，作者把 query complexity 分成了哪几类？系统分别会选择什么策略？",
      mustMatch: [/A|简单|straightforward|non-retrieval/i, /B|单步|single-step/i, /C|多步|multi-step/i],
    },
    {
      name: "adaptive-followup-figure",
      title: "2403.14403v2.pdf",
      message:
        "那篇 Adaptive-RAG 论文的 Figure 1 画的是什么？横轴和纵轴分别是什么？它想说明 Adaptive-RAG 在性能和耗时上处于什么位置？",
      mustMatch: [/Time per Query|耗时/i, /Performance|F1|性能/i],
    },
    {
      name: "numeric-miss",
      noSources: true,
      message:
        "我本地有一篇 9999 开头、讲 Adaptive-RAG 的论文，它的核心 idea 是什么？",
      mustMatch: [/9999/, /没有|not found/i],
    },
    {
      name: "visrag-numbers",
      title: "2410.10594v2.pdf",
      message:
        "我最近看了一篇论文，以2410开头，是讲visrag的，论文用什么具体数字论证 VisRAG-Ret 比 ColPali 更省内存？评估指标里，数值型答案允许多大的误差容限？",
      mustMatch: [/256\s?KB/i, /4\.5\s?KB/i, /5\s?%|5 percent/i],
    },
  ];

  if (!RUN_ONLY_DISCONNECT) {
    for (const test of tests) await runCase(test);
  }
  if (RUN_DISCONNECT || RUN_ONLY_DISCONNECT) await runDisconnectCase();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
