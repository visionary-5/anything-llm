const { v4: uuidv4 } = require("uuid");
const { DocumentManager } = require("../DocumentManager");
const { WorkspaceChats } = require("../../models/workspaceChats");
const { WorkspaceParsedFiles } = require("../../models/workspaceParsedFiles");
const { getVectorDbClass, resolveProviderConnector } = require("../helpers");
const { writeResponseChunk } = require("../helpers/chat/responses");
const { grepAgents } = require("./agents");
const {
  grepCommand,
  VALID_COMMANDS,
  chatPrompt,
  formatSourceForContext,
  formatSourcesForContext,
  recentChatHistory,
  sourceIdentifier,
  stripHiddenReasoning,
  retryEmptyStreamCompletion,
  localSearchQueryForMessage,
  localFileSearchQuery,
  localPathCapabilityResponse,
  localSearchFailureResponse,
  localSearchMissResponse,
  diversifySourcesByDocument,
  constrainSourcesToLocalMatches,
  evidenceSourcesForLocalMatches,
  hasLocalMatchedDocuments,
  localIndexWithHistoryAnchors,
  sourcesForClient,
} = require("./index");
const { maybeIndexLocalSourcesForQuery } = require("../wiciLocalSources");
const { lexicalEvidenceForQuery } = require("../wiciLocalRag");
const { planLocalQuery } = require("../wiciLocalQueryPlanner");

const VALID_CHAT_MODE = ["automatic", "chat", "query"];

async function streamChatWithWorkspace(
  response,
  workspace,
  message,
  chatMode = "automatic",
  user = null,
  thread = null,
  attachments = []
) {
  const uuid = uuidv4();
  const updatedMessage = await grepCommand(message, user);

  if (Object.keys(VALID_COMMANDS).includes(updatedMessage)) {
    const data = await VALID_COMMANDS[updatedMessage](
      workspace,
      message,
      uuid,
      user,
      thread
    );
    writeResponseChunk(response, data);
    return;
  }

  // If is agent enabled chat we will exit this flow early.
  const isAgentChat = await grepAgents({
    uuid,
    response,
    message: updatedMessage,
    user,
    workspace,
    thread,
    attachments,
  });
  if (isAgentChat) return;

  const {
    connector: LLMConnector,
    routingMetadata,
    prefetchedContext,
    error: routerError,
  } = await resolveLLMConnector({
    workspace,
    message: updatedMessage,
    user,
    thread,
    attachments,
  });

  if (routerError) {
    return writeResponseChunk(response, {
      id: uuid,
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error: routerError,
    });
  }

  if (routingMetadata?.routedTo?.shouldNotify) {
    writeResponseChunk(response, {
      uuid: `${uuid}:route`,
      type: "modelRouteNotification",
      routedTo: routingMetadata.routedTo,
    });
  }

  const VectorDb = getVectorDbClass();

  const messageLimit = workspace?.openAiHistory || 20;
  const historyContextForLocal =
    prefetchedContext ??
    (await recentChatHistory({ user, workspace, thread, messageLimit }));
  const localSearchQuery = localSearchQueryForMessage(
    updatedMessage,
    historyContextForLocal.rawHistory
  );
  let localQueryPlan = null;
  let onDemandLocalIndex = null;
  try {
    localQueryPlan = await planLocalQuery({
      query: updatedMessage,
      rawHistory: localFileSearchQuery(updatedMessage)
        ? []
        : historyContextForLocal.rawHistory,
    });
  } catch (error) {
    console.error("[WICI Local RAG] Query planning failed.", error);
    const textResponse = localSearchFailureResponse();
    const metrics = {
      wiciLocalRag: {
        phase: "query_planning",
        error: error.message,
        contextSources: 0,
      },
    };
    writeResponseChunk(response, {
      uuid,
      type: "textResponse",
      textResponse,
      sources: [],
      close: true,
      error: null,
      metrics,
      wiciLocalIndex: {
        skipped: true,
        reason: "query_planning_failed",
        error: error.message,
      },
    });
    await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: message,
      response: {
        text: textResponse,
        sources: [],
        type: chatMode,
        attachments,
        metrics,
      },
      threadId: thread?.id || null,
      include: false,
      user,
    });
    return;
  }
  if (localQueryPlan?.intent === "path_capability_question") {
    const textResponse = localPathCapabilityResponse();
    writeResponseChunk(response, {
      uuid,
      type: "textResponse",
      textResponse,
      sources: [],
      close: true,
      error: null,
      metrics: {
        wiciLocalRag: {
          plannerModel: localQueryPlan?.model || null,
          plannerIntent: localQueryPlan?.intent || null,
          contextSources: 0,
        },
      },
      wiciLocalIndex: {
        skipped: true,
        reason: "path_capability_question",
        queryPlan: localQueryPlan,
      },
    });
    await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: message,
      response: {
        text: textResponse,
        sources: [],
        type: chatMode,
        attachments,
        metrics: {
          wiciLocalRag: {
            plannerModel: localQueryPlan?.model || null,
            plannerIntent: localQueryPlan?.intent || null,
            contextSources: 0,
          },
        },
      },
      threadId: thread?.id || null,
      include: false,
      user,
    });
    return;
  }
  try {
    onDemandLocalIndex = await maybeIndexLocalSourcesForQuery({
      workspace,
      userId: user?.id || null,
      query: localSearchQuery,
      queryPlan: localQueryPlan,
      chatMode,
    });
  } catch (error) {
    console.error("[WICI Local RAG] On-demand local indexing failed.", error);
    const textResponse = localSearchFailureResponse();
    const metrics = {
      wiciLocalRag: {
        phase: "on_demand_indexing",
        plannerModel: localQueryPlan?.model || null,
        plannerIntent: localQueryPlan?.intent || null,
        error: error.message,
        contextSources: 0,
      },
    };
    writeResponseChunk(response, {
      uuid,
      type: "textResponse",
      textResponse,
      sources: [],
      close: true,
      error: null,
      metrics,
      wiciLocalIndex: {
        skipped: true,
        reason: "on_demand_indexing_failed",
        error: error.message,
        queryPlan: localQueryPlan,
      },
    });
    await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: message,
      response: {
        text: textResponse,
        sources: [],
        type: chatMode,
        attachments,
        metrics,
      },
      threadId: thread?.id || null,
      include: false,
      user,
    });
    return;
  }
  onDemandLocalIndex.queryPlan = localQueryPlan;
  const localRagMetrics = {
    onDemandMs: onDemandLocalIndex?.elapsedMs ?? null,
    plannerModel: localQueryPlan?.model || null,
    plannerIntent: localQueryPlan?.intent || null,
    localSearchQueryChanged: localSearchQuery !== updatedMessage,
    vectorSearchMs: null,
    rerankMs: null,
    lexicalEvidenceMs: null,
    contextSources: 0,
  };
  if (onDemandLocalIndex?.strictLocalMiss) {
    const textResponse = onDemandLocalIndex.numericTerms?.length
      ? `我没有在已索引或可发现的本地文件里找到匹配 ${onDemandLocalIndex.numericTerms.join(", ")} 的文件。`
      : localSearchMissResponse();
    writeResponseChunk(response, {
      uuid,
      type: "textResponse",
      textResponse,
      sources: [],
      close: true,
      error: null,
      metrics: { wiciLocalRag: localRagMetrics },
      wiciLocalIndex: onDemandLocalIndex,
    });
    await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: message,
      response: {
        text: textResponse,
        sources: [],
        type: chatMode,
        attachments,
        metrics: { wiciLocalRag: localRagMetrics },
      },
      threadId: thread?.id || null,
      user,
    });
    return;
  }
  const hasVectorizedSpace = await VectorDb.hasNamespace(workspace.slug);
  const embeddingsCount = await VectorDb.namespaceCount(workspace.slug);

  // User is trying to query-mode chat a workspace that has no data in it - so
  // we should exit early as no information can be found under these conditions.
  if ((!hasVectorizedSpace || embeddingsCount === 0) && chatMode === "query") {
    const textResponse =
      workspace?.queryRefusalResponse ??
      "There is no relevant information in this workspace to answer your query.";
    writeResponseChunk(response, {
      id: uuid,
      type: "textResponse",
      textResponse,
      sources: [],
      attachments,
      close: true,
      error: null,
      wiciLocalIndex: onDemandLocalIndex,
    });
    await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: message,
      response: {
        text: textResponse,
        sources: [],
        type: chatMode,
        attachments,
      },
      threadId: thread?.id || null,
      include: false,
      user,
    });
    return;
  }

  // If we are here we know that we are in a workspace that is:
  // 1. Chatting in "chat" mode and may or may _not_ have embeddings
  // 2. Chatting in "query" mode and has at least 1 embedding
  let completeText;
  let metrics = {};
  let contextTexts = [];
  let sources = [];
  let pinnedDocIdentifiers = [];

  // If the router pre-fetched context we can reuse it; otherwise fetch fresh.
  const {
    rawHistory,
    chatHistory,
    pinnedDocs: prefetchedPinnedDocs,
    parsedFiles: prefetchedParsedFiles,
  } = historyContextForLocal;
  const localIndex = localIndexWithHistoryAnchors(
    onDemandLocalIndex,
    rawHistory,
    updatedMessage
  );

  // Pinned docs — reuse pre-fetched if available, otherwise fetch with token cap.
  const pinnedDocs =
    prefetchedPinnedDocs ??
    (await new DocumentManager({
      workspace,
      maxTokens: LLMConnector.promptWindowLimit(),
    }).pinnedDocs());
  pinnedDocs.forEach((doc) => {
    const { pageContent, ...metadata } = doc;
    pinnedDocIdentifiers.push(sourceIdentifier(doc));
    contextTexts.push(
      formatSourceForContext({ pageContent, ...metadata }, contextTexts.length)
    );
    sources.push({
      text:
        pageContent.slice(0, 1_000) + "...continued on in source document...",
      ...metadata,
    });
  });

  // Parsed files — reuse pre-fetched if available, otherwise fetch fresh.
  const parsedFiles =
    prefetchedParsedFiles ??
    (await WorkspaceParsedFiles.getContextFiles(
      workspace,
      thread || null,
      user || null
    ));
  parsedFiles.forEach((doc) => {
    const { pageContent, ...metadata } = doc;
    contextTexts.push(
      formatSourceForContext({ pageContent, ...metadata }, contextTexts.length)
    );
    sources.push({
      text:
        pageContent.slice(0, 1_000) + "...continued on in source document...",
      ...metadata,
    });
  });

  const vectorSearchStarted = Date.now();
  const vectorSearchResults =
    embeddingsCount !== 0
      ? await VectorDb.performSimilaritySearch({
          namespace: workspace.slug,
          input: updatedMessage,
          LLMConnector,
          similarityThreshold: workspace?.similarityThreshold,
          topN: workspace?.topN,
          filterIdentifiers: pinnedDocIdentifiers,
          rerank: workspace?.vectorSearchMode === "rerank",
        })
      : {
          contextTexts: [],
          sources: [],
          message: null,
        };
  localRagMetrics.vectorSearchMs = Date.now() - vectorSearchStarted;
  localRagMetrics.rerankMs = vectorSearchResults.rerankLatencyMs ?? null;

  // Failed similarity search if it was run at all and failed.
  if (!!vectorSearchResults.message) {
    writeResponseChunk(response, {
      id: uuid,
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error: vectorSearchResults.message,
    });
    return;
  }

  const { fillSourceWindow } = require("../helpers/chat");
  const filledSources = fillSourceWindow({
    nDocs: workspace?.topN || 4,
    searchResults: vectorSearchResults.sources,
    history: rawHistory,
    filterIdentifiers: pinnedDocIdentifiers,
  });
  const diversifiedSources = diversifySourcesByDocument(filledSources.sources);
  const constrainedSources = constrainSourcesToLocalMatches(
    diversifiedSources,
    localIndex
  );
  const evidenceSources = evidenceSourcesForLocalMatches(
    diversifiedSources,
    localIndex
  );
  const lexicalEvidenceStarted = Date.now();
  const lexicalEvidence = await lexicalEvidenceForQuery({
    query: updatedMessage,
    queryPlan: localQueryPlan,
    sources: evidenceSources,
    workspaceId: workspace?.id,
    maxSnippets: Number(process.env.WICI_LOCAL_EXACT_SNIPPETS || 5),
  });
  localRagMetrics.lexicalEvidenceMs = Date.now() - lexicalEvidenceStarted;

  // Why does contextTexts get all the info, but sources only get current search?
  // This is to give the ability of the LLM to "comprehend" a contextual response without
  // populating the Citations under a response with documents the user "thinks" are irrelevant
  // due to how we manage backfilling of the context to keep chats with the LLM more correct in responses.
  // If a past citation was used to answer the question - that is visible in the history so it logically makes sense
  // and does not appear to the user that a new response used information that is otherwise irrelevant for a given prompt.
  // TLDR; reduces GitHub issues for "LLM citing document that has no answer in it" while keep answers highly accurate.
  contextTexts = [
    ...contextTexts,
    ...lexicalEvidence.contextTexts,
    ...(hasLocalMatchedDocuments(localIndex)
      ? []
      : formatSourcesForContext(
          constrainedSources,
          contextTexts.length + lexicalEvidence.contextTexts.length
        )),
  ];
  sources = [...sources, ...lexicalEvidence.sources, ...constrainedSources];
  const responseSources = sourcesForClient(sources);
  localRagMetrics.contextSources = responseSources.length;

  // If in query mode and no context chunks are found from search, backfill, or pins -  do not
  // let the LLM try to hallucinate a response or use general knowledge and exit early
  if (chatMode === "query" && contextTexts.length === 0) {
    const textResponse =
      localFileSearchQuery(updatedMessage) || localQueryPlan?.should_search_local
        ? localSearchMissResponse()
        : workspace?.queryRefusalResponse ??
          "There is no relevant information in this workspace to answer your query.";
    writeResponseChunk(response, {
      id: uuid,
      type: "textResponse",
      textResponse,
      sources: [],
      close: true,
      error: null,
      metrics: { wiciLocalRag: localRagMetrics },
      wiciLocalIndex: onDemandLocalIndex,
    });

    await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: message,
      response: {
        text: textResponse,
        sources: [],
        type: chatMode,
        attachments,
        metrics: { wiciLocalRag: localRagMetrics },
      },
      threadId: thread?.id || null,
      include: false,
      user,
    });
    return;
  }

  // Compress & Assemble message to ensure prompt passes token limit with room for response
  // and build system messages based on inputs and history.
  // Reuse the system prompt from routing pre-fetch when available.
  const systemPrompt =
    prefetchedContext?.systemPrompt ??
    (await chatPrompt(workspace, user, {
      prompt: updatedMessage,
      rawHistory,
    }));
  const messages = await LLMConnector.compressMessages(
    {
      systemPrompt,
      userPrompt: updatedMessage,
      contextTexts,
      chatHistory,
      attachments,
    },
    rawHistory
  );

  // If streaming is not explicitly enabled for connector
  // we do regular waiting of a response and send a single chunk.
  if (LLMConnector.streamingEnabled() !== true) {
    console.log(
      `\x1b[31m[STREAMING DISABLED]\x1b[0m Streaming is not available for ${LLMConnector.constructor.name}. Will use regular chat method.`
    );
    const { textResponse: rawTextResponse, metrics: performanceMetrics } =
      await LLMConnector.getChatCompletion(messages, {
        temperature: workspace?.openAiTemp ?? LLMConnector.defaultTemp,
        user: user,
      });

    completeText = stripHiddenReasoning(rawTextResponse);
    metrics = { ...performanceMetrics, wiciLocalRag: localRagMetrics };
    writeResponseChunk(response, {
      uuid,
      sources: responseSources,
      type: "textResponseChunk",
      textResponse: completeText,
      close: true,
      error: false,
      metrics,
    });
  } else {
    const stream = await LLMConnector.streamGetChatCompletion(messages, {
      temperature: workspace?.openAiTemp ?? LLMConnector.defaultTemp,
      user: user,
    });
    completeText = await LLMConnector.handleStream(response, stream, {
      uuid,
      sources: responseSources,
    });
    completeText = stripHiddenReasoning(completeText);
    metrics = { ...(stream.metrics || {}), wiciLocalRag: localRagMetrics };
  }

  if (!completeText?.length) {
    const retry = await retryEmptyStreamCompletion({
      LLMConnector,
      messages,
      temperature: workspace?.openAiTemp ?? LLMConnector.defaultTemp,
      user,
    });
    completeText = retry.textResponse;
    metrics = { ...(retry.metrics || metrics), wiciLocalRag: localRagMetrics };
    if (completeText?.length) {
      writeResponseChunk(response, {
        uuid,
        sources: responseSources,
        type: "textResponseChunk",
        textResponse: completeText,
        close: true,
        error: false,
        metrics,
        wiciLocalIndex: localIndex,
      });
    }
  }

  if (completeText?.length > 0) {
    const { chat } = await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: message,
      response: {
        text: completeText,
        sources: responseSources,
        type: chatMode,
        attachments,
        metrics,
      },
      threadId: thread?.id || null,
      user,
    });

    writeResponseChunk(response, {
      uuid,
      type: "finalizeResponseStream",
      close: true,
      error: false,
      chatId: chat.id,
      metrics,
      wiciLocalIndex: localIndex,
    });
    return;
  }

  writeResponseChunk(response, {
    uuid,
    type: "abort",
    textResponse: null,
    sources: [],
    close: true,
    error:
      "The model stream ended without a final answer. Retry the prompt or switch to a non-reasoning local model.",
    metrics,
    wiciLocalIndex: localIndex,
  });
  return;
}

async function resolveLLMConnector({
  workspace,
  message,
  user,
  thread,
  attachments,
}) {
  try {
    const result = await resolveProviderConnector({
      workspace,
      prompt: message,
      user,
      thread,
      attachments,
    });
    return { ...result, error: null };
  } catch (routerError) {
    return {
      connector: null,
      routingMetadata: null,
      prefetchedContext: null,
      error: `Model router error: ${routerError.message}`,
    };
  }
}

module.exports = {
  VALID_CHAT_MODE,
  streamChatWithWorkspace,
};
