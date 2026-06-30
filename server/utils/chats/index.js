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

When local document context is provided, treat it as search results from the user's indexed local data. Use document titles, source paths, source apps, file types, pages, and snippets to answer directly. If the user asks to find something, return the best matching local file or document and include the source path/title when available. Do not ask the user where the file is before using local context. If the indexed local context does not contain a match, say that it was not found in the indexed local data. Do not output hidden reasoning, chain-of-thought, "Thinking Process", or <think> blocks; only output the final answer.`;
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

function cleanMetadataValue(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  return String(value).slice(0, 1_000);
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
    page: source.page || source.pageNumber || null,
    score: source.score ?? null,
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
  if (Object.keys(metadata).length === 0) return body;

  return `<document_metadata>
${JSON.stringify(metadata, null, 2)}
</document_metadata>

${body}`;
}

function formatSourcesForContext(sources = [], startIndex = 0) {
  return sources
    .map((source, index) => formatSourceForContext(source, startIndex + index))
    .filter(Boolean);
}

function stripHiddenReasoning(text = "") {
  if (!text) return text;
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim();
}

module.exports = {
  sourceIdentifier,
  formatSourceForContext,
  formatSourcesForContext,
  stripHiddenReasoning,
  recentChatHistory,
  chatPrompt,
  grepCommand,
  grepAllSlashCommands,
  VALID_COMMANDS,
};
