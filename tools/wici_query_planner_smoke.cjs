#!/usr/bin/env node

const { planLocalQuery } = require("../server/utils/wiciLocalQueryPlanner");

const queries = [
  "帮我找那个盖了章的文件",
  "你可以索引别的路径吗",
  "比如saprk目录下有个两个女生的照片，请问这个照片叫什么名字",
  "我之前上传或索引过一张黑猫图片，帮我找出来。",
  "我本地那篇讲按问题难度选策略的 RAG 论文，核心想法是什么？",
  "我下载的那篇视觉版 RAG 论文，为什么说传统 TextRAG 会丢信息？",
];

async function main() {
  const started = Date.now();
  const rows = [];
  for (const query of queries) {
    const rowStarted = Date.now();
    const plan = await planLocalQuery({ query, rawHistory: [] });
    rows.push({
      query,
      elapsedMs: Date.now() - rowStarted,
      intent: plan.intent,
      scope: plan.search_scope,
      fileTypes: plan.file_types,
      concepts: plan.positive_concepts,
      visualTags: plan.visual_tags,
      needsIndexing: plan.needs_indexing,
      model: plan.model,
    });
  }

  console.log(
    JSON.stringify(
      {
        elapsedMs: Date.now() - started,
        rows,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
