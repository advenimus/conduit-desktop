import { useState, useCallback } from "react";
import { invoke } from "../../lib/electron";
import {
  AlertTriangleIcon, BanIcon, CheckIcon, CloseIcon, CopyIcon, DownloadIcon, FileImportIcon, FileTextIcon, FolderIcon, GlobeWwwIcon, KeyIcon, LoaderIcon, ServerAltIcon, ServerIcon, TerminalIcon
} from "../../lib/icons";

interface ImportPreviewEntry {
  rdmId: string;
  name: string;
  conduitType: string;
  status: "ready" | "unsupported" | "decrypt-failed" | "tier-limit" | "duplicate";
  statusMessage: string | null;
  folderPath: string | null;
  host: string | null;
  username: string | null;
  isGroupCredential: boolean;
  isDuplicate: boolean;
  existingEntryId: string | null;
}

type DuplicateStrategy = "overwrite" | "skip";

interface ImportEntryResult {
  name: string;
  conduitType: string;
  status: "imported" | "skipped" | "error" | "overwritten";
  message: string;
}

interface ImportResult {
  totalParsed: number;
  imported: number;
  skipped: number;
  errors: number;
  entries: ImportEntryResult[];
}

type Step = "select" | "preview" | "importing" | "results";

interface Props {
  onClose: () => void;
}

export default function ImportDialog({ onClose }: Props) {
  const [step, setStep] = useState<Step>("select");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [previewEntries, setPreviewEntries] = useState<ImportPreviewEntry[]>([]);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [duplicatePrompt, setDuplicatePrompt] = useState(false);

  const canClose = step !== "importing";

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && canClose) onClose();
  };

  // ── Step 1: Pick file ───────────────────────────────────────────
  const handlePickFile = useCallback(async () => {
    try {
      const path = await invoke<string | null>("import_pick_rdm_file");
      if (!path) return;
      setFilePath(path);
      setError(null);
      setLoading(true);

      const entries = await invoke<ImportPreviewEntry[]>("import_parse_rdm", {
        filePath: path,
      });

      setPreviewEntries(entries);
      setStep("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Step 2: Execute import ──────────────────────────────────────
  const handleImportClick = useCallback(() => {
    const dupeCount = previewEntries.filter((e) => e.isDuplicate).length;
    if (dupeCount > 0) {
      setDuplicatePrompt(true);
    } else {
      doImport();
    }
  }, [previewEntries]);

  const doImport = useCallback(async (strategy?: DuplicateStrategy) => {
    if (!filePath) return;
    setDuplicatePrompt(false);
    setStep("importing");
    setError(null);

    try {
      const importResult = await invoke<ImportResult>("import_execute_rdm", {
        filePath,
        duplicateStrategy: strategy,
      });
      setResult(importResult);
      setStep("results");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep("preview");
    }
  }, [filePath]);

  // ── Step 3: Save log ────────────────────────────────────────────
  const handleSaveLog = useCallback(async () => {
    if (!result) return;
    try {
      await invoke("import_save_log", { result });
    } catch {
      // User cancelled save dialog
    }
  }, [result]);

  // ── Computed counts ─────────────────────────────────────────────
  const readyCount = previewEntries.filter((e) => e.status === "ready").length;
  const decryptFailedCount = previewEntries.filter((e) => e.status === "decrypt-failed").length;
  const unsupportedCount = previewEntries.filter((e) => e.status === "unsupported").length;
  const tierLimitCount = previewEntries.filter((e) => e.status === "tier-limit").length;
  const duplicateCount = previewEntries.filter((e) => e.isDuplicate).length;

  // Group entries by folder path for preview
  const groupedEntries = groupByFolder(previewEntries);

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/50 z-50"
      onKeyDown={handleKeyDown}
      onClick={(e) => {
        if (e.target === e.currentTarget && canClose) onClose();
      }}
    >
      <div data-dialog-content className="w-full max-w-2xl bg-panel rounded-lg shadow-xl flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-stroke flex-shrink-0">
          <div className="flex items-center gap-2">
            <FileImportIcon size={20} className="text-conduit-400" />
            <h2 className="text-lg font-semibold">Import from Remote Desktop Manager</h2>
          </div>
          {canClose && (
            <button onClick={onClose} className="p-1 hover:bg-raised rounded">
              <CloseIcon size={18} />
            </button>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {step === "select" && (
            <SelectStep
              filePath={filePath}
              onPickFile={handlePickFile}
              loading={loading}
              error={error}
            />
          )}

          {step === "preview" && (
            <PreviewStep
              groupedEntries={groupedEntries}
              readyCount={readyCount}
              decryptFailedCount={decryptFailedCount}
              unsupportedCount={unsupportedCount}
              tierLimitCount={tierLimitCount}
              duplicateCount={duplicateCount}
              duplicatePrompt={duplicatePrompt}
              onDuplicateStrategy={(s) => doImport(s)}
              error={error}
            />
          )}

          {step === "importing" && (
            <div className="flex flex-col items-center gap-3 py-12">
              <LoaderIcon size={32} className="text-conduit-400 animate-spin" />
              <p className="text-ink-muted">Importing entries...</p>
            </div>
          )}

          {step === "results" && result && (
            <ResultsStep result={result} />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-stroke flex-shrink-0">
          {step === "select" && (
            <button onClick={onClose} className="px-4 py-2 text-sm rounded hover:bg-raised">
              Cancel
            </button>
          )}

          {step === "preview" && !duplicatePrompt && (
            <>
              <button
                onClick={() => { setStep("select"); setPreviewEntries([]); setDuplicatePrompt(false); }}
                className="px-4 py-2 text-sm rounded hover:bg-raised"
              >
                Back
              </button>
              <button
                onClick={handleImportClick}
                disabled={readyCount + decryptFailedCount + duplicateCount === 0}
                className="px-4 py-2 text-sm rounded bg-conduit-600 hover:bg-conduit-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Import {readyCount + decryptFailedCount + duplicateCount} {readyCount + decryptFailedCount + duplicateCount === 1 ? "Entry" : "Entries"}
              </button>
            </>
          )}

          {step === "results" && (
            <>
              <button
                onClick={handleSaveLog}
                className="flex items-center gap-1.5 px-4 py-2 text-sm rounded hover:bg-raised"
              >
                <DownloadIcon size={16} />
                Save Log
              </button>
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm rounded bg-conduit-600 hover:bg-conduit-700 text-white"
              >
                Close
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────

function SelectStep({
  filePath,
  onPickFile,
  loading,
  error,
}: {
  filePath: string | null;
  onPickFile: () => void;
  loading: boolean;
  error: string | null;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-muted">
        Select a <code className="text-xs bg-raised px-1 py-0.5 rounded">.rdm</code> export file
        from Devolutions Remote Desktop Manager. Credentials will be decrypted automatically.
      </p>

      <div>
        <label className="block text-sm font-medium mb-1.5">Export File</label>
        <button
          onClick={onPickFile}
          disabled={loading}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded border border-stroke hover:bg-raised text-left disabled:opacity-50"
        >
          <FileImportIcon size={16} className="text-ink-muted flex-shrink-0" />
          <span className={filePath ? "" : "text-ink-muted"}>
            {loading ? "Parsing..." : filePath ? filePath.split(/[/\\]/).pop() : "Choose file..."}
          </span>
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded bg-red-500/10 text-red-400 text-sm">
          <AlertTriangleIcon size={16} className="flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

function PreviewStep({
  groupedEntries,
  readyCount,
  decryptFailedCount,
  unsupportedCount,
  tierLimitCount,
  duplicateCount,
  duplicatePrompt,
  onDuplicateStrategy,
  error,
}: {
  groupedEntries: Map<string, ImportPreviewEntry[]>;
  readyCount: number;
  decryptFailedCount: number;
  unsupportedCount: number;
  tierLimitCount: number;
  duplicateCount: number;
  duplicatePrompt: boolean;
  onDuplicateStrategy: (strategy: DuplicateStrategy) => void;
  error: string | null;
}) {
  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex flex-wrap gap-3 text-sm">
        <span className="flex items-center gap-1 text-green-400">
          <CheckIcon size={14} />
          {readyCount} ready
        </span>
        {decryptFailedCount > 0 && (
          <span className="flex items-center gap-1 text-amber-400">
            <AlertTriangleIcon size={14} />
            {decryptFailedCount} credential{decryptFailedCount !== 1 ? "s" : ""} could not be decrypted
          </span>
        )}
        {duplicateCount > 0 && (
          <span className="flex items-center gap-1 text-amber-400">
            <CopyIcon size={14} />
            {duplicateCount} duplicate{duplicateCount !== 1 ? "s" : ""}
          </span>
        )}
        {unsupportedCount > 0 && (
          <span className="flex items-center gap-1 text-ink-muted">
            <BanIcon size={14} />
            {unsupportedCount} unsupported
          </span>
        )}
        {tierLimitCount > 0 && (
          <span className="flex items-center gap-1 text-red-400">
            <BanIcon size={14} />
            {tierLimitCount} tier limit
          </span>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded bg-red-500/10 text-red-400 text-sm">
          <AlertTriangleIcon size={16} className="flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Duplicate strategy prompt */}
      {duplicatePrompt && (
        <div className="p-4 rounded-lg border border-amber-500/30 bg-amber-500/5 space-y-3">
          <p className="text-sm text-amber-200">
            {duplicateCount} {duplicateCount === 1 ? "entry already exists" : "entries already exist"} in your vault.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => onDuplicateStrategy("overwrite")}
              className="px-3 py-1.5 text-sm rounded bg-amber-600 hover:bg-amber-700 text-white"
            >
              Overwrite All
            </button>
            <button
              onClick={() => onDuplicateStrategy("skip")}
              className="px-3 py-1.5 text-sm rounded border border-stroke hover:bg-raised"
            >
              Skip All
            </button>
          </div>
        </div>
      )}

      {/* Grouped entry list */}
      <div className="space-y-3 max-h-[40vh] overflow-y-auto">
        {Array.from(groupedEntries.entries()).map(([folder, entries]) => (
          <div key={folder}>
            <div className="flex items-center gap-1.5 text-sm font-medium text-ink-muted mb-1">
              <FolderIcon size={14} />
              {folder || "Root"}
            </div>
            <div className="space-y-0.5 ml-4">
              {entries.map((entry) => (
                <PreviewEntryRow key={entry.rdmId} entry={entry} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PreviewEntryRow({ entry }: { entry: ImportPreviewEntry }) {
  const TypeIcon = getTypeIcon(entry.conduitType);

  return (
    <div className="flex items-center gap-2 py-1 px-2 rounded text-sm hover:bg-raised">
      <TypeIcon size={14} className="flex-shrink-0 text-ink-muted" />
      <span className="flex-1 truncate">{entry.name}</span>
      {entry.host && (
        <span className="text-xs text-ink-muted truncate max-w-[140px]">{entry.host}</span>
      )}
      <StatusBadge status={entry.status} />
    </div>
  );
}

function StatusBadge({ status }: { status: ImportPreviewEntry["status"] }) {
  switch (status) {
    case "ready":
      return (
        <span className="flex items-center gap-0.5 text-xs text-green-400">
          <CheckIcon size={12} />
        </span>
      );
    case "duplicate":
      return (
        <span className="flex items-center gap-0.5 text-xs text-amber-400" title="Duplicate entry">
          <CopyIcon size={12} />
        </span>
      );
    case "decrypt-failed":
      return (
        <span className="flex items-center gap-0.5 text-xs text-amber-400" title="Password decryption failed">
          <AlertTriangleIcon size={12} />
        </span>
      );
    case "unsupported":
      return (
        <span className="flex items-center gap-0.5 text-xs text-ink-muted" title="Unsupported type">
          <BanIcon size={12} />
        </span>
      );
    case "tier-limit":
      return (
        <span className="flex items-center gap-0.5 text-xs text-red-400" title="Tier limit">
          <BanIcon size={12} />
        </span>
      );
  }
}

function ResultsStep({ result }: { result: ImportResult }) {
  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="grid grid-cols-3 gap-3 text-center">
        <div className="p-3 rounded bg-green-500/10">
          <div className="text-2xl font-bold text-green-400">{result.imported}</div>
          <div className="text-xs text-ink-muted">Imported</div>
        </div>
        <div className="p-3 rounded bg-amber-500/10">
          <div className="text-2xl font-bold text-amber-400">{result.skipped}</div>
          <div className="text-xs text-ink-muted">Skipped</div>
        </div>
        <div className="p-3 rounded bg-red-500/10">
          <div className="text-2xl font-bold text-red-400">{result.errors}</div>
          <div className="text-xs text-ink-muted">Errors</div>
        </div>
      </div>

      {/* Detail log */}
      <div className="space-y-0.5 max-h-[35vh] overflow-y-auto">
        {result.entries.map((entry, i) => (
          <div
            key={i}
            className={`flex items-center gap-2 py-1.5 px-2 rounded text-sm ${
              entry.status === "error" ? "bg-red-500/5" : ""
            }`}
          >
            <ResultIcon status={entry.status} />
            <span className="flex-shrink-0 text-xs text-ink-muted w-16">{entry.conduitType}</span>
            <span className="flex-1 truncate">{entry.name}</span>
            <span className="text-xs text-ink-muted truncate max-w-[200px]">{entry.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ResultIcon({ status }: { status: ImportEntryResult["status"] }) {
  switch (status) {
    case "imported":
      return <CheckIcon size={14} className="text-green-400 flex-shrink-0" />;
    case "overwritten":
      return <CopyIcon size={14} className="text-blue-400 flex-shrink-0" />;
    case "skipped":
      return <BanIcon size={14} className="text-amber-400 flex-shrink-0" />;
    case "error":
      return <AlertTriangleIcon size={14} className="text-red-400 flex-shrink-0" />;
  }
}

// ── Utilities ────────────────────────────────────────────────────────

function getTypeIcon(type: string) {
  switch (type) {
    case "ssh": return TerminalIcon;
    case "rdp": return ServerIcon;
    case "vnc": return ServerAltIcon;
    case "web": return GlobeWwwIcon;
    case "credential": return KeyIcon;
    case "document": return FileTextIcon;
    case "folder": return FolderIcon;
    default: return ServerIcon;
  }
}

function groupByFolder(entries: ImportPreviewEntry[]): Map<string, ImportPreviewEntry[]> {
  const map = new Map<string, ImportPreviewEntry[]>();

  for (const entry of entries) {
    // Skip pure folder entries (no credentials)
    if (entry.conduitType === "folder" && !entry.isGroupCredential) continue;

    const folder = entry.folderPath ?? "";
    const list = map.get(folder) ?? [];
    list.push(entry);
    map.set(folder, list);
  }

  return map;
}
