import {
  ArrowsClockwise,
  CheckCircle,
  CircleNotch,
  FolderOpen,
  HardDrives,
  MagnifyingGlass,
  Play,
  WarningCircle,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import Workspace from "@/models/workspace";
import showToast from "@/utils/toast";

const DEFAULT_EXTENSIONS =
  ".jpg,.jpeg,.png,.webp,.gif,.bmp,.pdf,.txt,.md,.csv,.json,.docx,.xlsx";

function pathsFromText(text) {
  return text
    .split(/\n|,/)
    .map((path) => path.trim())
    .filter(Boolean);
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024)
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export default function LocalFolders({ workspace, fetchKeys }) {
  const [info, setInfo] = useState(null);
  const [rootsText, setRootsText] = useState("~/Pictures");
  const [extensions, setExtensions] = useState(DEFAULT_EXTENSIONS);
  const [limit, setLimit] = useState(100);
  const [maxMb, setMaxMb] = useState(50);
  const [force, setForce] = useState(false);
  const [preview, setPreview] = useState(null);
  const [job, setJob] = useState(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [startingJob, setStartingJob] = useState(false);

  const roots = useMemo(() => pathsFromText(rootsText), [rootsText]);
  const isRunning = ["queued", "running"].includes(job?.status);
  const progressPct =
    job?.current?.total > 0
      ? Math.round((job.current.index / job.current.total) * 100)
      : job?.status === "complete"
        ? 100
        : 0;

  useEffect(() => {
    async function load() {
      const result = await Workspace.localSources(workspace.slug);
      if (result?.success) {
        setInfo(result);
        if (result.activeJob) setJob(result.activeJob);
      }
    }
    load();
  }, [workspace.slug]);

  useEffect(() => {
    if (!job?.id || !isRunning) return;

    const interval = setInterval(async () => {
      const result = await Workspace.localSourceJob(workspace.slug, job.id);
      if (!result?.success || !result.job) return;
      setJob(result.job);
      if (["complete", "failed"].includes(result.job.status)) {
        await fetchKeys(true);
        showToast(
          result.job.status === "complete"
            ? "Local folder indexing complete"
            : `Local folder indexing failed: ${result.job.error}`,
          result.job.status === "complete" ? "success" : "error"
        );
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [fetchKeys, isRunning, job?.id, workspace.slug]);

  function body() {
    return {
      roots,
      extensions,
      maxBytes: Number(maxMb || 0) * 1024 * 1024,
      limit: Number(limit || 0),
      force,
    };
  }

  async function runPreview() {
    if (roots.length === 0) {
      showToast("Add at least one local path.", "error");
      return;
    }
    setLoadingPreview(true);
    const result = await Workspace.previewLocalSource(workspace.slug, body());
    setLoadingPreview(false);
    if (!result?.success) {
      showToast(result?.error || "Failed to preview local folders.", "error");
      return;
    }
    setPreview(result);
  }

  async function startIndexing() {
    if (roots.length === 0) {
      showToast("Add at least one local path.", "error");
      return;
    }
    if (
      roots.some((root) => ["/", "~"].includes(root)) &&
      !window.confirm("This scans a broad local path. Continue?")
    ) {
      return;
    }

    setStartingJob(true);
    const result = await Workspace.indexLocalSource(workspace.slug, body());
    setStartingJob(false);
    if (!result?.success) {
      showToast(result?.error || "Failed to start local indexing.", "error");
      if (result?.job) setJob(result.job);
      return;
    }
    setJob(result.job);
    showToast("Local folder indexing started.", "success");
  }

  if (info && !info.enabled) return null;

  return (
    <div className="mx-8 mb-8 w-[1184px] rounded-2xl border border-theme-modal-border bg-theme-settings-input-bg p-5">
      <div className="flex items-center justify-between gap-x-6">
        <div className="flex items-center gap-x-3 min-w-0">
          <div className="h-9 w-9 rounded-lg bg-theme-bg-primary border border-theme-modal-border flex items-center justify-center shrink-0">
            <HardDrives size={20} className="text-theme-text-primary" />
          </div>
          <div className="min-w-0">
            <h3 className="text-theme-text-primary text-base font-bold">
              Local folders
            </h3>
            <p className="text-theme-text-secondary text-xs truncate">
              {info?.state?.indexedFiles || 0} indexed local files
              {info?.state?.lastIndexedAt
                ? ` - last ${new Date(info.state.lastIndexedAt).toLocaleString()}`
                : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-x-2 shrink-0">
          <button
            disabled={loadingPreview || isRunning}
            onClick={runPreview}
            className="h-9 px-3 rounded-lg border border-theme-modal-border text-theme-text-primary text-sm font-semibold hover:bg-theme-bg-secondary disabled:opacity-50 disabled:cursor-wait flex items-center gap-x-2"
          >
            {loadingPreview ? (
              <CircleNotch size={16} className="animate-spin" />
            ) : (
              <MagnifyingGlass size={16} />
            )}
            Dry run
          </button>
          <button
            disabled={startingJob || isRunning}
            onClick={startIndexing}
            className="h-9 px-3 rounded-lg bg-primary-button text-white text-sm font-semibold hover:opacity-90 disabled:opacity-50 disabled:cursor-wait flex items-center gap-x-2"
          >
            {startingJob || isRunning ? (
              <CircleNotch size={16} className="animate-spin" />
            ) : (
              <Play size={16} weight="fill" />
            )}
            Index now
          </button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-12 gap-4">
        <div className="col-span-5">
          <label className="text-theme-text-secondary text-xs font-semibold">
            Paths
          </label>
          <textarea
            value={rootsText}
            onChange={(event) => setRootsText(event.target.value)}
            className="mt-2 h-[96px] w-full resize-none rounded-lg border border-theme-modal-border bg-theme-bg-primary p-3 text-sm text-theme-text-primary placeholder:text-theme-settings-input-placeholder focus:outline-primary-button"
            placeholder={"~/Pictures\n~/Documents"}
          />
          <div className="mt-2 flex flex-wrap gap-2">
            {(info?.presets || []).map((preset) => (
              <button
                key={preset.label}
                onClick={() => setRootsText(preset.path)}
                className="h-7 px-2 rounded-lg border border-theme-modal-border text-theme-text-secondary hover:text-theme-text-primary hover:bg-theme-bg-secondary text-xs flex items-center gap-x-1"
                title={preset.description}
              >
                <FolderOpen size={13} />
                {preset.label === "Full disk" ? "All Mac" : preset.label}
              </button>
            ))}
          </div>
        </div>

        <div className="col-span-3">
          <label className="text-theme-text-secondary text-xs font-semibold">
            File types
          </label>
          <textarea
            value={extensions}
            onChange={(event) => setExtensions(event.target.value)}
            className="mt-2 h-[96px] w-full resize-none rounded-lg border border-theme-modal-border bg-theme-bg-primary p-3 text-sm text-theme-text-primary focus:outline-primary-button"
          />
          <label className="mt-3 flex items-center gap-x-2 text-theme-text-secondary text-xs">
            <input
              type="checkbox"
              checked={force}
              onChange={(event) => setForce(event.target.checked)}
              className="accent-primary-button"
            />
            Re-index unchanged files
          </label>
        </div>

        <div className="col-span-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-theme-text-secondary text-xs font-semibold">
              Max files
              <input
                type="number"
                min="0"
                value={limit}
                onChange={(event) => setLimit(event.target.value)}
                className="mt-2 h-9 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 text-sm text-theme-text-primary focus:outline-primary-button"
              />
            </label>
            <label className="text-theme-text-secondary text-xs font-semibold">
              Max MB/file
              <input
                type="number"
                min="1"
                value={maxMb}
                onChange={(event) => setMaxMb(event.target.value)}
                className="mt-2 h-9 w-full rounded-lg border border-theme-modal-border bg-theme-bg-primary px-3 text-sm text-theme-text-primary focus:outline-primary-button"
              />
            </label>
          </div>

          <StatusPanel preview={preview} job={job} progressPct={progressPct} />
        </div>
      </div>
    </div>
  );
}

function StatusPanel({ preview, job, progressPct }) {
  if (job) {
    const summary = job.summary || {};
    return (
      <div className="mt-4 rounded-lg border border-theme-modal-border bg-theme-bg-primary p-3">
        <div className="flex items-center justify-between gap-x-4">
          <div className="flex items-center gap-x-2 min-w-0">
            {job.status === "complete" ? (
              <CheckCircle size={16} className="text-green-400 shrink-0" />
            ) : job.status === "failed" ? (
              <WarningCircle size={16} className="text-red-400 shrink-0" />
            ) : (
              <ArrowsClockwise
                size={16}
                className="text-theme-text-primary animate-spin shrink-0"
              />
            )}
            <p className="text-theme-text-primary text-sm font-semibold truncate">
              {job.status}
            </p>
          </div>
          <p className="text-theme-text-secondary text-xs shrink-0">
            {summary.ok || 0}/{summary.attempted || 0} indexed
          </p>
        </div>
        <div className="mt-3 h-2 w-full rounded-full bg-theme-settings-input-bg overflow-hidden">
          <div
            className="h-full bg-primary-button transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <p className="mt-2 text-theme-text-secondary text-xs truncate">
          {job.current?.path || job.error || `${summary.seen || 0} files seen`}
        </p>
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="mt-4 rounded-lg border border-theme-modal-border bg-theme-bg-primary p-3">
        <p className="text-theme-text-secondary text-xs">
          Ready to scan selected local paths.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-theme-modal-border bg-theme-bg-primary p-3">
      <div className="grid grid-cols-4 gap-2 text-xs">
        <Metric label="Seen" value={preview.summary?.seen || 0} />
        <Metric label="New" value={preview.summary?.changedOrNew || 0} />
        <Metric label="Index" value={preview.summary?.toIndex || 0} />
        <Metric label="Skipped" value={preview.skipped?.length || 0} />
      </div>
      {preview.candidates?.length > 0 && (
        <p className="mt-3 text-theme-text-secondary text-xs truncate">
          Next: {preview.candidates[0].path} (
          {formatBytes(preview.candidates[0].size)})
        </p>
      )}
      {preview.truncated && (
        <p className="mt-2 text-yellow-300 text-xs">
          Scan limit reached; narrow the path or raise the limit.
        </p>
      )}
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div>
      <p className="text-theme-text-secondary">{label}</p>
      <p className="text-theme-text-primary text-sm font-semibold">{value}</p>
    </div>
  );
}
