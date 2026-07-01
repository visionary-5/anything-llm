const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { describeImageForSearchIndex } = require("../VLMImageDescription");

const execFileAsync = promisify(execFile);

function log(text, ...args) {
  console.log(`\x1b[35m[PDFPreviewDescription]\x1b[0m ${text}`, ...args);
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
  return envFlagEnabled("WICI_ENRICH_PDF_PREVIEW_VLM_ENABLED", true);
}

function quickLookPath() {
  return process.env.WICI_PDF_PREVIEW_QLMANAGE_PATH || "/usr/bin/qlmanage";
}

function previewSize() {
  return Math.max(
    256,
    Number(process.env.WICI_PDF_PREVIEW_SIZE || 1400)
  );
}

function previewTimeoutMs() {
  return Math.max(
    1_000,
    Number(process.env.WICI_PDF_PREVIEW_TIMEOUT_MS || 30_000)
  );
}

function findGeneratedPreview(dir, pdfPath) {
  const base = path.basename(pdfPath);
  const candidates = fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".png"))
    .map((name) => path.join(dir, name));

  return (
    candidates.find((file) => path.basename(file).startsWith(base)) ||
    candidates[0] ||
    null
  );
}

async function renderPdfPreview(pdfPath) {
  const qlmanage = quickLookPath();
  if (!fs.existsSync(qlmanage)) {
    log(`QuickLook renderer not found at ${qlmanage}.`);
    return null;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wici-pdf-preview-"));
  try {
    await execFileAsync(
      qlmanage,
      ["-t", "-s", String(previewSize()), "-o", dir, pdfPath],
      { timeout: previewTimeoutMs(), windowsHide: true }
    );
    return findGeneratedPreview(dir, pdfPath);
  } catch (error) {
    log(`QuickLook PDF preview failed for ${path.basename(pdfPath)}: ${error.message}`);
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

async function describePdfPreviewForSearchIndex(
  pdfPath,
  { filename = "pdf" } = {}
) {
  if (!isEnabled()) return "";
  if (!pdfPath || !fs.existsSync(pdfPath)) return "";

  const previewPath = await renderPdfPreview(pdfPath);
  if (!previewPath) return "";

  try {
    const description = await describeImageForSearchIndex(previewPath, {
      filename: `${filename} preview`,
    });
    if (!description) return "";
    return `# WICI PDF Visual Preview\n${description}`;
  } catch (error) {
    log(`VLM preview description failed for ${filename}: ${error.message}`);
    return "";
  } finally {
    fs.rmSync(path.dirname(previewPath), { recursive: true, force: true });
  }
}

module.exports = {
  describePdfPreviewForSearchIndex,
  isEnabled,
  renderPdfPreview,
};
