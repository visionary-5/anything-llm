const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "qwen3.5:4b";
const TIMEOUT_MS = 20_000;

const ALLOWED_INTENTS = new Set([
  "document_qa",
  "document_switch",
  "file_search",
  "image_search",
  "path_capability_question",
  "visual_file_search",
  "unknown",
]);

const ALLOWED_SCOPES = new Set([
  "current_workspace",
  "documents",
  "downloads",
  "desktop",
  "pictures",
  "user_home",
  "all_mac",
]);

const ALLOWED_FILE_TYPES = new Set([
  "pdf",
  "image",
  "docx",
  "xlsx",
  "txt",
  "md",
  "csv",
  "json",
]);

function envFlagEnabled(name, defaultValue = true) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "")
    return defaultValue;
  return !["0", "false", "off", "no", "disabled"].includes(
    String(value).trim().toLowerCase()
  );
}

function enabled() {
  return envFlagEnabled("WICI_QUERY_PLANNER_ENABLED", true);
}

function baseUrl() {
  return (process.env.WICI_QUERY_PLANNER_BASE_URL || DEFAULT_BASE_URL).replace(
    /\/+$/,
    ""
  );
}

function modelName() {
  return process.env.WICI_QUERY_PLANNER_MODEL || DEFAULT_MODEL;
}

function normalizeText(value = "") {
  return String(value).toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();
}

function uniqueStrings(values = [], { max = 12 } = {}) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || "").trim();
    if (!text) continue;
    const key = normalizeText(text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text.slice(0, 120));
    if (out.length >= max) break;
  }
  return out;
}

function recentPrompts(rawHistory = []) {
  return rawHistory
    .slice(-6)
    .map((chat) => chat?.prompt)
    .filter((prompt) => typeof prompt === "string" && prompt.trim())
    .slice(-4);
}

function extractJson(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] || raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function sanitizePlan(plan = {}, query = "") {
  if (!plan || typeof plan !== "object") plan = {};
  const normalizedQuery = normalizeText(query);
  let intent = ALLOWED_INTENTS.has(plan.intent) ? plan.intent : "unknown";
  if (
    intent === "visual_file_search" &&
    /(图片|照片|图像|截图|相册|猫|黑猫|女生|女孩|浴室|洗手台|image|photo|picture|screenshot|cat)/i.test(
      normalizedQuery
    )
  ) {
    intent = "image_search";
  }
  let searchScope = ALLOWED_SCOPES.has(plan.search_scope)
    ? plan.search_scope
    : "current_workspace";
  if (/(saprk|user home|home directory|主目录|家目录|用户目录)/i.test(normalizedQuery))
    searchScope = "user_home";
  if (/(全盘|all mac|整个电脑|整台电脑|full disk)/i.test(normalizedQuery))
    searchScope = "all_mac";
  const fileTypes = uniqueStrings(plan.file_types, { max: 8 })
    .map((type) => normalizeText(type).replace(/^\./, ""))
    .filter((type) => ALLOWED_FILE_TYPES.has(type));
  const shouldSearchLocal =
    intent === "path_capability_question"
      ? false
      : Boolean(plan.should_search_local);

  return {
    planner: plan.planner || "ollama",
    model: plan.model || modelName(),
    should_search_local: shouldSearchLocal,
    needs_indexing:
      intent === "path_capability_question"
        ? false
        : Boolean(plan.needs_indexing) ||
          (shouldSearchLocal && searchScope !== "current_workspace"),
    intent,
    search_scope: searchScope,
    file_types: fileTypes,
    positive_concepts: uniqueStrings(plan.positive_concepts, { max: 16 }),
    negative_concepts: uniqueStrings(plan.negative_concepts, { max: 10 }),
    visual_tags: uniqueStrings(plan.visual_tags, { max: 16 }).map((tag) =>
      normalizeText(tag).replace(/\s+/g, "_")
    ),
    document_hints: uniqueStrings(plan.document_hints, { max: 10 }),
    rewritten_queries: uniqueStrings(plan.rewritten_queries, { max: 8 }),
    answer_guidance: String(plan.answer_guidance || "").slice(0, 500),
    original_query: query,
  };
}

function fallbackPlan(query = "") {
  const normalized = normalizeText(query);
  const imageLike =
    /(image|photo|picture|screenshot|照片|图片|截图|相册|女生|女孩|女人|猫)/i.test(
      normalized
    );
  const visualDocLike =
    /(盖章|印章|公章|红章|stamp|seal|signature|签名|空白|blank)/i.test(normalized);
  const pathCapabilityQuestion =
    /(索引.*路径|路径.*索引|别的路径|其他路径|全盘|home|saprk|目录)/i.test(
      normalized
    ) && !/(找|搜|查|叫什么|名字|find|search|locate)/i.test(normalized);
  return sanitizePlan(
    {
      planner: "fallback",
      model: "none",
      should_search_local:
        !pathCapabilityQuestion || /找|搜|查|叫什么|名字|find|search/i.test(normalized),
      needs_indexing: imageLike || visualDocLike || pathCapabilityQuestion,
      intent: pathCapabilityQuestion
        ? "path_capability_question"
        : visualDocLike
          ? "visual_file_search"
          : imageLike
            ? "image_search"
            : "unknown",
      search_scope: /全盘|all mac|整个电脑/i.test(normalized)
        ? "all_mac"
        : /saprk|home|主目录|家目录/i.test(normalized)
          ? "user_home"
          : imageLike
            ? "pictures"
            : "current_workspace",
      file_types: visualDocLike ? ["pdf", "image"] : imageLike ? ["image"] : [],
      positive_concepts: [query],
      rewritten_queries: [query],
    },
    query
  );
}

function systemPrompt() {
  const examples = [
    {
      query: "我本地那篇讲按问题难度选择检索策略的论文，核心想法是什么？",
      plan: {
        should_search_local: true,
        needs_indexing: true,
        intent: "document_qa",
        search_scope: "documents",
        file_types: ["pdf"],
        positive_concepts: [
          "query complexity",
          "strategy selection",
          "non-retrieval",
          "single-step retrieval",
          "multi-step retrieval",
        ],
        negative_concepts: [],
        visual_tags: [],
        document_hints: [
          "paper about choosing retrieval strategy by question difficulty",
        ],
        rewritten_queries: ["query complexity retrieval strategy selection"],
        answer_guidance:
          "Answer from the matching paper, cite title/path when available.",
      },
    },
    {
      query: "帮我找那个盖了章的文件",
      plan: {
        should_search_local: true,
        needs_indexing: true,
        intent: "visual_file_search",
        search_scope: "documents",
        file_types: ["pdf", "image"],
        positive_concepts: ["stamped document", "official seal", "red stamp"],
        negative_concepts: [],
        visual_tags: ["has_stamp", "red_stamp", "seal"],
        document_hints: [],
        rewritten_queries: ["file with red stamp or official seal"],
        answer_guidance: "Return the best matching file path/title.",
      },
    },
    {
      query: "用户目录下有个两个女生的照片，请问这个照片叫什么名字",
      plan: {
        should_search_local: true,
        needs_indexing: true,
        intent: "image_search",
        search_scope: "user_home",
        file_types: ["image"],
        positive_concepts: ["two girls", "two women", "photo of two people"],
        negative_concepts: [],
        visual_tags: ["photo_people", "two_people"],
        document_hints: [],
        rewritten_queries: ["image containing two girls"],
        answer_guidance: "Return the image file name/path.",
      },
    },
    {
      query: "你可以索引别的路径吗",
      plan: {
        should_search_local: false,
        needs_indexing: false,
        intent: "path_capability_question",
        search_scope: "current_workspace",
        file_types: [],
        positive_concepts: [],
        negative_concepts: [],
        visual_tags: [],
        document_hints: [],
        rewritten_queries: [],
        answer_guidance: "Explain supported local folder indexing controls.",
      },
    },
  ];

  return [
    "You are a local-search query planner for a private desktop RAG system.",
    "You do not answer the user. Return one compact JSON object only.",
    "Use JSON only. No markdown, no analysis, no chain-of-thought.",
    "The JSON controls local indexing and retrieval for files, PDFs, images, OCR, VLM captions, and metadata.",
    "Resolve whether the user is asking about a document, switching documents, finding a file, finding an image, asking about indexing paths, or searching visual attributes.",
    "Extract positive concepts and negative concepts. Negative concepts are things the user explicitly says not to use, such as 'don't use VisRAG'.",
    "When the user asks in Chinese, keep short Chinese identity hints if useful, but also add concise English search concepts for retrieval.",
    "For visual searches, produce English concepts and short visual_tags. Examples: has_stamp, red_stamp, seal, blank_page, mostly_blank, black_cat, photo_people, two_people, camera, phone, receipt.",
    "Choose search_scope from: current_workspace, documents, downloads, desktop, pictures, user_home, all_mac.",
    "Choose intent from: document_qa, document_switch, file_search, image_search, path_capability_question, visual_file_search, unknown.",
    "Choose file_types from: pdf, image, docx, xlsx, txt, md, csv, json.",
    "Set needs_indexing=true when the user expects local files outside the current indexed context.",
    "Examples:",
    ...examples.map(
      ({ query, plan }) => `Query: ${JSON.stringify(query)} -> ${JSON.stringify(plan)}`
    ),
    "Return exactly this JSON shape:",
    '{"should_search_local":true,"needs_indexing":false,"intent":"unknown","search_scope":"current_workspace","file_types":[],"positive_concepts":[],"negative_concepts":[],"visual_tags":[],"document_hints":[],"rewritten_queries":[],"answer_guidance":""}',
  ].join("\n");
}

async function ollamaPlan(query = "", rawHistory = []) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelName(),
        stream: false,
        think: false,
        format: "json",
        messages: [
          { role: "system", content: systemPrompt() },
          {
            role: "user",
            content: JSON.stringify({
              query,
              recent_user_prompts: recentPrompts(rawHistory),
            }),
          },
        ],
        options: {
          temperature: 0,
          num_ctx: 2048,
          num_predict: 600,
        },
        keep_alive: "24h",
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(raw.slice(0, 500));
    const parsed = JSON.parse(raw);
    const plan = extractJson(parsed?.message?.content);
    if (!plan) throw new Error("Planner returned non-JSON output.");
    return sanitizePlan({ ...plan, planner: "ollama", model: modelName() }, query);
  } finally {
    clearTimeout(timeout);
  }
}

async function planLocalQuery({ query = "", rawHistory = [] } = {}) {
  if (!enabled()) return fallbackPlan(query);
  try {
    return await ollamaPlan(query, rawHistory);
  } catch (error) {
    console.warn(
      `[WICI Query Planner] Falling back after planner failure: ${error.message}`
    );
    return fallbackPlan(query);
  }
}

function planTerms(plan = {}) {
  if (!plan || typeof plan !== "object") return [];
  return uniqueStrings(
    [
      ...(plan.positive_concepts || []),
      ...(plan.visual_tags || []),
      ...(plan.document_hints || []),
      ...(plan.rewritten_queries || []),
    ],
    { max: 40 }
  );
}

module.exports = {
  enabled,
  fallbackPlan,
  planLocalQuery,
  planTerms,
};
