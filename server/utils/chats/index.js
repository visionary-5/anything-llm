const { v4: uuidv4 } = require("uuid");
const { WorkspaceChats } = require("../../models/workspaceChats");
const { resetMemory } = require("./commands/reset");
const { convertToPromptHistory } = require("../helpers/chat/responses");
const { SlashCommandPresets } = require("../../models/slashCommandsPresets");
const { SystemPromptVariables } = require("../../models/systemPromptVariables");

const VALID_COMMANDS = {
  "/reset": resetMemory,
};

async function grepCommand(message, user = null) {
  const userPresets = await SlashCommandPresets.getUserPresets(user?.id);
  const availableCommands = Object.keys(VALID_COMMANDS);

  // Check if the message starts with any built-in command
  for (let i = 0; i < availableCommands.length; i++) {
    const cmd = availableCommands[i];
    const re = new RegExp(`^(${cmd})`, "i");
    if (re.test(message)) {
      return cmd;
    }
  }

  // Replace all preset commands with their corresponding prompts
  // Allows multiple commands in one message
  let updatedMessage = message;
  for (const preset of userPresets) {
    const regex = new RegExp(
      `(?:\\b\\s|^)(${preset.command})(?:\\b\\s|$)`,
      "g"
    );
    updatedMessage = updatedMessage.replace(regex, preset.prompt);
  }

  return updatedMessage;
}

/**
 * @description This function will do recursive replacement of all slash commands with their corresponding prompts.
 * @notice This function is used for API calls and is not user-scoped. THIS FUNCTION DOES NOT SUPPORT PRESET COMMANDS.
 * @returns {Promise<string>}
 */
async function grepAllSlashCommands(message) {
  const allPresets = await SlashCommandPresets.where({});

  // Replace all preset commands with their corresponding prompts
  // Allows multiple commands in one message
  let updatedMessage = message;
  for (const preset of allPresets) {
    const regex = new RegExp(
      `(?:\\b\\s|^)(${preset.command})(?:\\b\\s|$)`,
      "g"
    );
    updatedMessage = updatedMessage.replace(regex, preset.prompt);
  }

  return updatedMessage;
}

async function recentChatHistory({
  user = null,
  workspace,
  thread = null,
  messageLimit = 20,
  apiSessionId = null,
}) {
  const rawHistory = (
    await WorkspaceChats.where(
      {
        workspaceId: workspace.id,
        user_id: user?.id || null,
        thread_id: thread?.id || null,
        api_session_id: apiSessionId || null,
        include: true,
      },
      messageLimit,
      { id: "desc" }
    )
  ).reverse();
  return { rawHistory, chatHistory: convertToPromptHistory(rawHistory) };
}

/**
 * Returns the base prompt for the chat with memories appended (when enabled).
 * Also does variable substitution on the prompt if there are any defined variables.
 * @param {Object|null} workspace - the workspace object
 * @param {Object|null} user - the user object
 * @param {{prompt?: string, rawHistory?: object[]}} [opts] - current user message + chat history, used for reranking injected memories
 * @returns {Promise<string>}
 */
async function chatPrompt(workspace, user = null, opts = {}) {
  const { SystemSettings } = require("../../models/systemSettings");
  const { promptWithMemories } = require("../memories");
  const basePrompt =
    workspace?.openAiPrompt ?? SystemSettings.saneDefaultSystemPrompt;
  const systemPrompt = await SystemPromptVariables.expandSystemPromptVariables(
    basePrompt,
    user?.id,
    workspace?.id
  );
  const memoryPrompt = await promptWithMemories({
    systemPrompt,
    userId: user?.id ?? null,
    workspaceId: workspace?.id,
    prompt: opts.prompt ?? "",
    rawHistory: opts.rawHistory ?? [],
  });
  if (String(process.env.WICI_LOCAL_RAG_PROMPT_ENABLED ?? "true") === "false")
    return memoryPrompt;

  return `${memoryPrompt}

When local document context is provided, treat it as search results from the user's indexed local data. Use document titles, source paths, source apps, file types, pages, and snippets to answer directly. Context marked as WICI exact local evidence or evidence_type=lexical_document_window is higher-priority than broad vector chunks for exact numbers, formulas, tables, and metric definitions. If a WICI structured table hint is present, use it as the parsed table representation and include every requested row and column exactly. If the user asks to find something, return the best matching local file or document and include the source path/title when available. Do not ask the user where the file is before using local context. If the indexed local context does not contain a match, say that it was not found in the indexed local data. If the user asks whether other local paths can be indexed, answer that this fork can index selected local folders such as Home, Desktop, Documents, Pictures, Downloads, or Full disk through the Local folders controls, and that newly discovered files may need indexing before they become searchable. Do not claim you cannot change or expand local index paths. Do not output hidden reasoning, chain-of-thought, "Thinking Process", or <think> blocks; only output the final answer.`;
}

// We use this util function to deduplicate sources from similarity searching
// if the document is already pinned.
// Eg: You pin a csv, if we RAG + full-text that you will get the same data
// points both in the full-text and possibly from RAG - result in bad results
// even if the LLM was not even going to hallucinate.
function sourceIdentifier(sourceDocument) {
  if (!sourceDocument?.title || !sourceDocument?.published) return uuidv4();
  return `title:${sourceDocument.title}-timestamp:${sourceDocument.published}`;
}

function normalizedSourceValues(source = {}) {
  return [
    source.location,
    source.sourcePath,
    source.chunkSource,
    source.url,
    source.title,
    source.filename,
    source.name,
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase().normalize("NFKC"));
}

function sourceMatchesLocalDocument(source = {}, document = {}) {
  const sourceValues = normalizedSourceValues(source);
  const documentValues = normalizedSourceValues(document);
  return sourceValues.some((sourceValue) =>
    documentValues.some(
      (documentValue) =>
        sourceValue === documentValue ||
        sourceValue.includes(documentValue) ||
        documentValue.includes(sourceValue)
    )
  );
}

function localMatchedDocuments(localIndex = {}) {
  return Array.isArray(localIndex?.matchedDocuments)
    ? localIndex.matchedDocuments
    : [];
}

function hasLocalMatchedDocuments(localIndex = {}) {
  return localMatchedDocuments(localIndex).length > 0;
}

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeLocalAnchorText(value = "") {
  return String(value).toLowerCase().normalize("NFKC").replace(/\s+/g, " ");
}

function localAnchorTerms(query = "") {
  const normalized = normalizeLocalAnchorText(query);
  const terms = new Set();
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9._-]{2,}/g))
    terms.add(match[0]);
  for (const match of normalized.matchAll(/[\u4e00-\u9fff]{2,}/g))
    terms.add(match[0]);
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
    add("adaptive-rag", "query complexity", "classifier");
  if (/(按|根据).*(难度|复杂度).*(策略|选择|选)/i.test(normalized))
    add("adaptive-rag", "single-step", "multi-step");
  if (/(难度|复杂度).*(策略|分流|选择|选)/i.test(normalized))
    add("adaptive-rag", "query complexity");
  if (
    !negatesVisual &&
    /(视觉|视图|图像|图片|vision|visual|visrag|multi-?modal)/i.test(normalized)
  )
    add("visrag", "vision-based", "multi-modality", "document image", "vlm");
  if (
    !negatesSelf &&
    /(self-?rag|\bself\b.*(rag|开头|论文|paper)|自我|反思|reflection|批判|critique)/i.test(
      normalized
    )
  )
    add("self-rag", "reflection tokens", "isrel", "issup", "isuse");
  const generic = new Set([
    "rag",
    "the",
    "and",
    "with",
    "this",
    "that",
    "paper",
    "query",
    "complexity",
    "figure",
    "table",
    "pdf",
    "local",
    "file",
    "document",
    "那篇",
    "这篇",
    "该论文",
    "论文",
    "作者",
    "系统",
    "分别",
    "什么",
    "横轴",
    "纵轴",
  ]);
  return Array.from(terms).filter((term) => !generic.has(term));
}

function localDocumentFollowupQuery(query = "") {
  return /(那篇|这篇|该论文|该文|上面|刚才|前面|上一轮|继续|figure\s*\d+|fig\.\s*\d+|图\s*\d+|表\s*\d+|that paper|this paper|the paper|same paper|it\b)/i.test(
    query
  );
}

function localDocumentResetQuery(query = "") {
  return /(新的?论文|新的?文档|新检索|重新检索|重新搜索|全局检索|全盘检索|换一篇|换一个|另一篇|另一个|不是这篇|不是这个|new paper|new document|new search|search again|different paper|another paper)/i.test(
    query
  );
}

function previousUserPrompt(rawHistory = []) {
  const previous = rawHistory
    .slice()
    .reverse()
    .find((chat) => typeof chat?.prompt === "string" && chat.prompt.trim());
  return previous?.prompt || "";
}

function localSearchQueryForMessage(query = "", rawHistory = []) {
  if (!localDocumentResetQuery(query)) return query;

  const previousPrompt = previousUserPrompt(rawHistory);
  if (!previousPrompt) return query;
  return `${previousPrompt}\n${query}`;
}

function responseLooksLikeLocalMiss(response = {}) {
  const text = normalizeLocalAnchorText(response?.text || "");
  return /(未找到|没有找到|无法基于|不包含|not found|does not contain|no relevant)/i.test(
    text
  );
}

function sourceLooksLocal(source = {}) {
  const values = [
    source.sourcePath,
    source.chunkSource,
    source.url,
    source.docSource,
    source.location,
  ]
    .filter(Boolean)
    .map((value) => String(value));
  return values.some(
    (value) =>
      value.startsWith("file://") ||
      value.startsWith("/") ||
      /wici local/i.test(value)
  );
}

function historySourceToMatch(source = {}, score = 0, matchedTerms = []) {
  return {
    title: source.title || source.filename || source.name,
    location: source.location,
    chunkSource: source.chunkSource,
    sourcePath: source.sourcePath,
    docSource: source.docSource || "WICI local history anchor",
    score,
    wiciLocalSourceMatch: true,
    wiciLocalHistoryAnchor: true,
    wiciLocalMatchedTerms: matchedTerms,
  };
}

function scoreHistoryLocalSource(source = {}, query = "", recency = 0) {
  const terms = localAnchorTerms(query);
  const searchable = normalizeLocalAnchorText(
    [
      source.title,
      source.filename,
      source.name,
      source.sourcePath,
      source.chunkSource,
      source.url,
      source.docSource,
      String(source.text || source.pageContent || "").slice(0, 2_000),
    ]
      .filter(Boolean)
      .join("\n")
  );
  const matchedTerms = terms.filter((term) => searchable.includes(term));
  const hasSpecificTerms = terms.some((term) => /^[a-z0-9][a-z0-9._-]{3,}$/i.test(term));
  if (hasSpecificTerms && matchedTerms.length === 0) return null;

  const followup = localDocumentFollowupQuery(query);
  if (!followup && matchedTerms.length === 0) return null;

  const score =
    Math.max(0, 20 - recency) +
    matchedTerms.reduce((total, term) => {
      if (/^\d{3,}/.test(term)) return total + 100;
      if (/^[a-z0-9][a-z0-9._-]{3,}$/i.test(term)) return total + 30;
      return total + 8;
    }, 0) +
    (followup ? 10 : 0);

  return historySourceToMatch(source, score, matchedTerms);
}

function localHistoryMatchesForQuery(rawHistory = [], query = "") {
  const matches = [];
  const seen = new Set();
  const recent = rawHistory.slice(-8).reverse();
  for (const [recency, chat] of recent.entries()) {
    const response =
      typeof chat?.response === "string"
        ? safeJsonParse(chat.response, {})
        : chat?.response || {};
    if (responseLooksLikeLocalMiss(response)) continue;
    const sources = Array.isArray(response?.sources) ? response.sources : [];
    for (const source of sources) {
      if (!sourceLooksLocal(source) || !source.location) continue;
      const match = scoreHistoryLocalSource(source, query, recency);
      if (!match) continue;
      const key = match.location || match.sourcePath || match.chunkSource;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      matches.push(match);
    }
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, 5);
}

function localIndexWithHistoryAnchors(localIndex = {}, rawHistory = [], query = "") {
  if (localIndex?.strictLocalMiss) return localIndex;
  if (localDocumentResetQuery(query)) return localIndex;
  const historyMatches = localHistoryMatchesForQuery(rawHistory, query);
  if (historyMatches.length === 0) return localIndex;

  if (localDocumentFollowupQuery(query)) {
    return {
      ...localIndex,
      reason: "history_local_document_anchor",
      matchedDocuments: historyMatches,
    };
  }

  if (!hasLocalMatchedDocuments(localIndex)) {
    return {
      ...localIndex,
      reason: "history_local_document_match",
      matchedDocuments: historyMatches,
    };
  }

  return localIndex;
}

function constrainSourcesToLocalMatches(sources = [], localIndex = {}) {
  const matches = localMatchedDocuments(localIndex);
  if (matches.length === 0) return sources;

  const filtered = sources.filter((source) =>
    matches.some((match) => sourceMatchesLocalDocument(source, match))
  );
  return filtered.length > 0 ? filtered : matches;
}

function evidenceSourcesForLocalMatches(sources = [], localIndex = {}) {
  const matches = localMatchedDocuments(localIndex);
  if (matches.length === 0) return sources;
  return [...matches, ...constrainSourcesToLocalMatches(sources, localIndex)];
}

function cleanMetadataValue(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  return String(value).slice(0, 1_000);
}

function pageFromSource(source = {}) {
  if (source.page || source.pageNumber) return source.page || source.pageNumber;
  const body = contextBodyFromSource(source);
  const match = String(body || "").match(/\[WICI_PAGE\s+page=([^\]]+)\]/i);
  return match?.[1] || null;
}

function sourceMetadataForContext(source = {}, index = null) {
  const metadata = {
    context_id: index === null ? null : index,
    title: source.title || source.filename || source.name || null,
    source_path: source.sourcePath || source.chunkSource || source.url || null,
    chunk_source: source.chunkSource || null,
    document_source: source.docSource || null,
    document_type: source.documentType || source.type || null,
    author: source.docAuthor || null,
    published: source.published || null,
    page: pageFromSource(source),
    score: source.score ?? null,
    evidence_type: source.wiciEvidenceType || null,
    evidence_start: source.wiciEvidenceStart ?? null,
    evidence_end: source.wiciEvidenceEnd ?? null,
  };

  return Object.fromEntries(
    Object.entries(metadata)
      .map(([key, value]) => [key, cleanMetadataValue(value)])
      .filter(([, value]) => value !== null)
  );
}

function contextBodyFromSource(source = {}) {
  return source.pageContent || source.text || "";
}

function formatSourceForContext(source = {}, index = null) {
  const body = contextBodyFromSource(source);
  if (!body) return "";
  const metadata = sourceMetadataForContext(source, index);
  const contextId =
    index === null || index === undefined ? "" : ` id="${String(index)}"`;
  if (Object.keys(metadata).length === 0)
    return `<wici_context${contextId}>
<document_body>
${body}
</document_body>
</wici_context>`;

  return `<wici_context${contextId}>
<document_metadata>
${JSON.stringify(metadata, null, 2)}
</document_metadata>

<document_body>
${body}
</document_body>
</wici_context>`;
}

function formatSourcesForContext(sources = [], startIndex = 0) {
  return sources
    .map((source, index) => formatSourceForContext(source, startIndex + index))
    .filter(Boolean);
}

function trimSourceText(value = "") {
  const text = String(value || "");
  const limit = Math.max(
    200,
    Number(process.env.WICI_LOCAL_SOURCE_SNIPPET_CHARS || 1_200)
  );
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...continued on in source document...`;
}

function normalizeClientSourceKey(value = "") {
  return String(value).toLowerCase().normalize("NFKC").replace(/\s+/g, " ");
}

function sourceForClient(source = {}) {
  const { pageContent, text, ...metadata } = source;
  const snippet = trimSourceText(text || pageContent || "");
  return {
    ...metadata,
    ...(snippet ? { text: snippet, pageContent: snippet } : {}),
  };
}

function sourcesForClient(sources = []) {
  const seen = new Set();
  const responseSources = [];
  for (const source of sources) {
    const clientSource = sourceForClient(source);
    const key = [
      clientSource.location,
      clientSource.sourcePath,
      clientSource.chunkSource,
      clientSource.url,
      clientSource.title,
      clientSource.wiciEvidenceType,
      clientSource.wiciEvidenceStart,
      normalizeClientSourceKey(clientSource.text || "").slice(0, 300),
    ]
      .filter((value) => value !== null && value !== undefined && value !== "")
      .join(":");
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    responseSources.push(clientSource);
  }
  return responseSources;
}

function localPathCapabilityResponse() {
  return [
    "可以。这个 fork 支持通过 Local folders 索引本地路径，常用范围包括 Home、Desktop、Documents、Pictures、Downloads，也可以选择 Full disk。",
    "新路径或新文件需要先完成索引后才会进入可检索范围；图片和扫描 PDF 还需要 OCR/VLM enrichment 后，视觉内容才更容易被搜到。",
  ].join("\n");
}

function documentKeyForSource(source = {}) {
  return normalizeClientSourceKey(
    source.sourcePath ||
      source.chunkSource ||
      source.url ||
      source.location ||
      source.title ||
      source.filename ||
      source.name ||
      ""
  );
}

function diversifySourcesByDocument(
  sources = [],
  {
    maxPerDocument = Number(process.env.WICI_LOCAL_MAX_CHUNKS_PER_DOC || 2),
    maxDocuments = Number(process.env.WICI_LOCAL_MAX_CONTEXT_DOCS || 8),
  } = {}
) {
  if (!Array.isArray(sources) || sources.length === 0) return [];
  const perDocument = new Map();
  const selected = [];
  const seenDocuments = new Set();

  for (const source of sources) {
    const key = documentKeyForSource(source) || uuidv4();
    const count = perDocument.get(key) || 0;
    if (count >= maxPerDocument) continue;
    if (!seenDocuments.has(key) && seenDocuments.size >= maxDocuments) continue;

    perDocument.set(key, count + 1);
    seenDocuments.add(key);
    selected.push(source);
  }

  return selected;
}

function stripHiddenReasoning(text = "") {
  if (!text) return text;
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim();
}

async function retryEmptyStreamCompletion({
  LLMConnector,
  messages,
  temperature,
  user = null,
} = {}) {
  if (!LLMConnector || typeof LLMConnector.getChatCompletion !== "function")
    return { textResponse: "", metrics: {} };

  try {
    console.warn(
      "[WICI Local RAG] Streaming response ended empty; retrying once with non-streamed completion."
    );
    const { textResponse: rawTextResponse, metrics = {} } =
      await LLMConnector.getChatCompletion(messages, {
        temperature,
        user,
      });
    return {
      textResponse: stripHiddenReasoning(rawTextResponse),
      metrics,
    };
  } catch (error) {
    console.warn(
      "[WICI Local RAG] Non-streamed retry after empty stream failed.",
      error?.message || error
    );
    return { textResponse: "", metrics: {} };
  }
}

module.exports = {
  sourceIdentifier,
  formatSourceForContext,
  formatSourcesForContext,
  stripHiddenReasoning,
  retryEmptyStreamCompletion,
  localSearchQueryForMessage,
  localDocumentResetQuery,
  localPathCapabilityResponse,
  diversifySourcesByDocument,
  constrainSourcesToLocalMatches,
  evidenceSourcesForLocalMatches,
  hasLocalMatchedDocuments,
  localIndexWithHistoryAnchors,
  sourcesForClient,
  recentChatHistory,
  chatPrompt,
  grepCommand,
  grepAllSlashCommands,
  VALID_COMMANDS,
};
