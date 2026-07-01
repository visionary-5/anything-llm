const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "qwen2.5vl:7b";
const MAX_IMAGE_DIMENSION = 1024;
const VISION_TIMEOUT_MS = 120_000;
const PROMPT_VERSION = "wici-vlm-search-card-v1";
const LEGACY_PROMPT =
  "Describe this image in detail for a document search index. " +
  "Include all visible text, diagrams, charts, tables, and their content. " +
  "Be thorough but factual.";
const SEARCH_CARD_PROMPT =
  "Create a factual local search index card for this image. " +
  "Use the exact labels below and keep each line concise but complete. " +
  "Do not invent details, names, brands, dates, or text that are not visible. " +
  "If a field is not present, write none.\n\n" +
  "SEARCH_SUMMARY: one sentence describing the image.\n" +
  "VISIBLE_TEXT: all readable text, preserving important numbers and labels.\n" +
  "OBJECTS: comma-separated visible objects, people, animals, UI elements, diagrams, tables, and charts.\n" +
  "SCENE: location or document/screenshot context.\n" +
  "COLORS_AND_ATTRIBUTES: important colors, shapes, counts, and visual attributes.\n" +
  "RELATIONSHIPS: spatial relationships and actions, for example camera next to phone.\n" +
  "DOCUMENT_TYPE: photo, screenshot, receipt, form, chart, table, diagram, page, or unknown.\n" +
  "VISUAL_TAGS: only include applicable tags from this list: has_stamp, red_stamp, seal, signature, blank_page, mostly_blank, form, receipt, chart, table, diagram, photo_people, two_people, cat, black_cat, phone, camera.\n" +
  "SEARCH_PHRASES: short natural-language phrases a user might search for to find this image.";

function log(text, ...args) {
  console.log(`\x1b[35m[VLMImageDescription]\x1b[0m ${text}`, ...args);
}

function envFlagEnabled(name, defaultValue = true) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "")
    return defaultValue;
  return !["0", "false", "off", "no", "disabled"].includes(
    String(value).trim().toLowerCase()
  );
}

function isEnabled() {
  return envFlagEnabled("WICI_ENRICH_VLM_ENABLED", true);
}

function searchCardEnabled() {
  return envFlagEnabled("WICI_ENRICH_VLM_INDEX_CARD_ENABLED", true);
}

function cacheEnabled() {
  return envFlagEnabled("WICI_ENRICH_VLM_CACHE_ENABLED", true);
}

function baseUrl() {
  return (process.env.WICI_ENRICH_VLM_BASE_URL || DEFAULT_BASE_URL).replace(
    /\/+$/,
    ""
  );
}

function modelName() {
  return process.env.WICI_ENRICH_VLM_MODEL || DEFAULT_MODEL;
}

function prompt() {
  if (process.env.WICI_ENRICH_VLM_PROMPT)
    return process.env.WICI_ENRICH_VLM_PROMPT;
  return searchCardEnabled() ? SEARCH_CARD_PROMPT : LEGACY_PROMPT;
}

function cacheDir() {
  if (process.env.WICI_ENRICH_VLM_CACHE_DIR)
    return path.resolve(process.env.WICI_ENRICH_VLM_CACHE_DIR);
  if (process.env.STORAGE_DIR)
    return path.resolve(process.env.STORAGE_DIR, "wici-enrichment-cache");

  return path.resolve(
    __dirname,
    "../../../server/storage/wici-enrichment-cache"
  );
}

function stripThinkTags(text = "") {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return cleaned || text.trim();
}

async function readImageBuffer(image) {
  if (Buffer.isBuffer(image)) return image;
  if (typeof image === "string") return fs.readFileSync(image);
  throw new Error("Image input must be a file path or Buffer.");
}

async function prepareImageForVlm(image) {
  const buffer = await readImageBuffer(image);
  try {
    return await sharp(buffer, { failOn: "none" })
      .rotate()
      .resize({
        width: MAX_IMAGE_DIMENSION,
        height: MAX_IMAGE_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch (error) {
    log(`Image resize failed, sending original bytes: ${error.message}`);
    return buffer;
  }
}

function imageDigest(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function cacheKey({ imageSha, promptText }) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        imageSha,
        model: modelName(),
        promptVersion: PROMPT_VERSION,
        promptText,
      })
    )
    .digest("hex");
}

function readCachedDescription(key) {
  if (!cacheEnabled()) return null;
  const filePath = path.resolve(cacheDir(), `${key}.json`);
  if (!fs.existsSync(filePath)) return null;

  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (typeof payload.description !== "string") return null;
    return payload.description;
  } catch (error) {
    log(`Ignoring unreadable VLM cache entry ${key}: ${error.message}`);
    return null;
  }
}

function writeCachedDescription(key, payload) {
  if (!cacheEnabled()) return;
  try {
    const dir = cacheDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.resolve(dir, `${key}.json`),
      JSON.stringify(payload, null, 2),
      "utf8"
    );
  } catch (error) {
    log(`Failed to write VLM cache entry ${key}: ${error.message}`);
  }
}

async function ollamaVision(imageBase64) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelName(),
        messages: [
          {
            role: "user",
            content: prompt(),
            images: [imageBase64],
          },
        ],
        stream: false,
        think: false,
        options: {
          num_ctx: 4096,
          num_predict: 4096,
          num_gpu: 99,
          temperature: 0.2,
        },
        keep_alive: "24h",
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(
        `Ollama returned ${response.status}: ${raw.slice(0, 500)}`
      );
    }

    const result = JSON.parse(raw);
    return stripThinkTags(result?.message?.content || "");
  } finally {
    clearTimeout(timeout);
  }
}

async function describeImageForSearchIndex(image, { filename = "image" } = {}) {
  if (!isEnabled()) return "";

  try {
    const originalBuffer = await readImageBuffer(image);
    const imageSha = imageDigest(originalBuffer);
    const promptText = prompt();
    const key = cacheKey({ imageSha, promptText });
    const cached = readCachedDescription(key);
    if (cached) {
      log(`Using cached VLM description for ${filename}`);
      return cached;
    }

    log(
      `Describing ${filename} with ${modelName()} at ${baseUrl()} ` +
        `(${searchCardEnabled() ? "search card" : "legacy prompt"})`
    );
    const vlmBuffer = await prepareImageForVlm(originalBuffer);
    const description = await ollamaVision(vlmBuffer.toString("base64"));
    if (!description) log(`No VLM description returned for ${filename}.`);
    if (description) {
      writeCachedDescription(key, {
        description,
        filename,
        imageSha,
        model: modelName(),
        baseUrl: baseUrl(),
        promptVersion: PROMPT_VERSION,
        searchCard: searchCardEnabled(),
        createdAt: new Date().toISOString(),
      });
    }
    return description;
  } catch (error) {
    log(`VLM description failed for ${filename}: ${error.message}`);
    return "";
  }
}

function combineOcrAndVlmText(ocrText = "", vlmDescription = "") {
  const ocr = String(ocrText || "").trim();
  const vlm = String(vlmDescription || "").trim();
  const parts = [];

  if (vlm)
    parts.push(
      searchCardEnabled()
        ? `# WICI Visual Search Index Card\n${vlm}`
        : `# Visual Description\n${vlm}`
    );
  if (ocr) parts.push(`# OCR Text\n${ocr}`);
  return parts.join("\n\n").trim();
}

module.exports = {
  cacheEnabled,
  combineOcrAndVlmText,
  describeImageForSearchIndex,
  isEnabled,
  searchCardEnabled,
};
