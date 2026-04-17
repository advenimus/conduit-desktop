import { useState, useCallback, type JSX } from "react";
import { invoke } from "../../lib/electron";
import {
  AlertTriangleIcon, CheckIcon, CloseIcon, DesktopIcon, EyeIcon, EyeOffIcon, FileImportIcon, FolderIcon, GlobeWwwIcon, KeyIcon, LoaderIcon, LockIcon, ServerIcon, TerminalIcon, UploadIcon
} from "../../lib/icons";

interface FolderTreeItem {
  id: string;
  name: string;
  parent_id: string | null;
}

interface ImportPreview {
  source_vault_name: string;
  exported_at: string;
  scope: string;
  scope_path: string | null;
  folder_count: number;
  entry_count: number;
  entry_type_counts: Record<string, number>;
  folder_tree: FolderTreeItem[];
}

interface ImportResult {
  foldersCreated: number;
  entriesCreated: number;
  credentialRefsRemapped: number;
  credentialRefsCleared: number;
}

type Step = "file" | "preview" | "importing" | "results";

interface Props {
  onClose: () => void;
}

export default function VaultImportDialog({ onClose }: Props) {
  const [step, setStep] = useState<Step>("file");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const canClose = step !== "importing";

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && canClose) onClose();
  };

  // ── Step 1: Pick file ───────────────────────────────────────────
  const handlePickFile = useCallback(async () => {
    try {
      const path = await invoke<string | null>("import_pick_export_file");
      if (!path) return;
      setFilePath(path);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // ── Step 1→2: Decrypt and preview ──────────────────────────────
  const handleDecrypt = useCallback(async () => {
    if (!filePath || !passphrase) return;
    setError(null);
    setLoading(true);

    try {
      const previewData = await invoke<ImportPreview>("import_preview_export", {
        filePath,
        passphrase,
      });
      setPreview(previewData);
      setStep("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [filePath, passphrase]);

  // ── Step 2→3: Execute import ───────────────────────────────────
  const handleImport = useCallback(async () => {
    if (!filePath || !passphrase) return;
    setStep("importing");
    setError(null);

    try {
      const importResult = await invoke<ImportResult>("import_execute_export", {
        filePath,
        passphrase,
      });
      setResult(importResult);
      setPassphrase("");
      setStep("results");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep("preview");
    }
  }, [filePath, passphrase]);

  // Determine import placement description
  const placementNote = preview
    ? preview.scope === "full"
      ? "All folders and entries will be imported into the vault root."
      : "Folders will be matched by name to existing root-level folders, or created if no match exists."
    : null;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/50 z-50"
      onKeyDown={handleKeyDown}
      onClick={(e) => {
        if (e.target === e.currentTarget && canClose) onClose();
      }}
    >
      <div data-dialog-content className="w-full max-w-lg bg-panel rounded-lg shadow-xl flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-stroke flex-shrink-0">
          <div className="flex items-center gap-2">
            <UploadIcon size={20} className="text-conduit-400" />
            <h2 className="text-lg font-semibold">Import from Export</h2>
          </div>
          {canClose && (
            <button onClick={onClose} className="p-1 hover:bg-raised rounded">
              <CloseIcon size={18} />
            </button>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {step === "file" && (
            <div className="space-y-4">
              {/* File picker */}
              <div>
                <label className="block text-sm font-medium mb-1.5">Export File</label>
                <button
                  onClick={handlePickFile}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded border border-stroke hover:bg-raised text-left"
                >
                  <FileImportIcon size={16} className="text-ink-muted flex-shrink-0" />
                  <span className={filePath ? "" : "text-ink-muted"}>
                    {filePath ? filePath.split(/[/\\]/).pop() : "Choose .conduit-export file..."}
                  </span>
                </button>
              </div>

              {/* Passphrase */}
              <div>
                <label className="block text-sm font-medium mb-1.5">
                  <span className="flex items-center gap-1">
                    <LockIcon size={14} />
                    Export Passphrase
                  </span>
                </label>
                <div className="relative">
                  <input
                    type={showPassphrase ? "text" : "password"}
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    placeholder="Enter the passphrase used during export"
                    className="w-full px-3 py-2 pr-9 text-sm rounded border border-stroke bg-canvas focus:border-conduit-500 focus:outline-none"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && filePath && passphrase) handleDecrypt();
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassphrase(!showPassphrase)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-ink-muted hover:text-ink"
                    tabIndex={-1}
                  >
                    {showPassphrase ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
                  </button>
                </div>
              </div>

              {error && (
                <div className="flex items-start gap-2 p-3 rounded bg-red-500/10 text-red-400 text-sm">
                  <AlertTriangleIcon size={16} className="flex-shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}
            </div>
          )}

          {step === "preview" && preview && (
            <div className="space-y-4">
              {/* Source info */}
              <div className="p-3 rounded bg-well text-sm space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-ink-muted">Source Vault</span>
                  <span className="font-medium">{preview.source_vault_name}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-ink-muted">Exported</span>
                  <span>{new Date(preview.exported_at).toLocaleDateString()}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-ink-muted">Scope</span>
                  <span>{preview.scope === "full" ? "Full vault" : preview.scope_path ?? "Folder"}</span>
                </div>
              </div>

              {/* Counts */}
              <div className="flex flex-wrap gap-3 text-sm">
                <span className="flex items-center gap-1">
                  <FolderIcon size={14} className="text-ink-muted" />
                  {preview.folder_count} folders
                </span>
                {Object.entries(preview.entry_type_counts).map(([type, count]) => (
                  <span key={type} className="flex items-center gap-1">
                    <EntryTypeIcon type={type} />
                    {count} {type}
                  </span>
                ))}
              </div>

              {/* Folder tree preview */}
              {preview.folder_tree.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-ink-muted mb-1.5">Folder Structure</label>
                  <div className="p-2 rounded bg-well text-xs space-y-0.5 max-h-32 overflow-y-auto">
                    {renderFolderTree(preview.folder_tree)}
                  </div>
                </div>
              )}

              {/* Placement info */}
              {placementNote && (
                <p className="text-xs text-ink-faint">
                  {placementNote}
                </p>
              )}

              {error && (
                <div className="flex items-start gap-2 p-3 rounded bg-red-500/10 text-red-400 text-sm">
                  <AlertTriangleIcon size={16} className="flex-shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}
            </div>
          )}

          {step === "importing" && (
            <div className="flex flex-col items-center gap-3 py-8">
              <LoaderIcon size={32} className="text-conduit-400 animate-spin" />
              <p className="text-ink-muted text-sm">Importing entries and folders...</p>
            </div>
          )}

          {step === "results" && result && (
            <div className="space-y-4">
              <div className="flex flex-col items-center gap-2 py-4">
                <div className="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center">
                  <CheckIcon size={24} className="text-green-400" />
                </div>
                <p className="text-sm font-medium">Import Complete</p>
              </div>

              <div className="grid grid-cols-2 gap-3 text-center">
                <div className="p-3 rounded bg-well">
                  <div className="text-xl font-bold text-conduit-400">{result.foldersCreated}</div>
                  <div className="text-xs text-ink-muted">Folders Created</div>
                </div>
                <div className="p-3 rounded bg-well">
                  <div className="text-xl font-bold text-conduit-400">{result.entriesCreated}</div>
                  <div className="text-xs text-ink-muted">Entries Created</div>
                </div>
              </div>

              {(result.credentialRefsRemapped > 0 || result.credentialRefsCleared > 0) && (
                <div className="text-xs text-ink-muted space-y-0.5">
                  {result.credentialRefsRemapped > 0 && (
                    <p>{result.credentialRefsRemapped} credential reference(s) remapped successfully</p>
                  )}
                  {result.credentialRefsCleared > 0 && (
                    <p>{result.credentialRefsCleared} credential reference(s) cleared (referenced credentials not in export)</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-stroke flex-shrink-0">
          {step === "file" && (
            <>
              <button onClick={onClose} className="px-4 py-2 text-sm rounded hover:bg-raised">
                Cancel
              </button>
              <button
                onClick={handleDecrypt}
                disabled={!filePath || !passphrase || loading}
                className="flex items-center gap-1.5 px-4 py-2 text-sm rounded bg-conduit-600 hover:bg-conduit-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? (
                  <>
                    <LoaderIcon size={14} className="animate-spin" />
                    Decrypting...
                  </>
                ) : (
                  "Continue"
                )}
              </button>
            </>
          )}

          {step === "preview" && (
            <>
              <button
                onClick={() => { setStep("file"); setPreview(null); setError(null); }}
                className="px-4 py-2 text-sm rounded hover:bg-raised"
              >
                Back
              </button>
              <button
                onClick={handleImport}
                className="px-4 py-2 text-sm rounded bg-conduit-600 hover:bg-conduit-700 text-white"
              >
                Import {preview ? preview.entry_count : 0} Entries
              </button>
            </>
          )}

          {step === "results" && (
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm rounded bg-conduit-600 hover:bg-conduit-700 text-white"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────

function EntryTypeIcon({ type }: { type: string }) {
  const props = { size: 14, stroke: 1.5, className: "text-ink-muted" };
  switch (type) {
    case "ssh": return <TerminalIcon {...props} />;
    case "rdp": return <DesktopIcon {...props} />;
    case "vnc": return <ServerIcon {...props} />;
    case "web": return <GlobeWwwIcon {...props} />;
    case "credential": return <KeyIcon {...props} />;
    default: return <ServerIcon {...props} />;
  }
}

function renderFolderTree(folders: FolderTreeItem[]) {
  const rootFolders = folders.filter(f => !f.parent_id || !folders.some(p => p.id === f.parent_id));
  const childMap = new Map<string, FolderTreeItem[]>();
  for (const f of folders) {
    if (f.parent_id) {
      const list = childMap.get(f.parent_id) ?? [];
      list.push(f);
      childMap.set(f.parent_id, list);
    }
  }

  const renderFolder = (folder: FolderTreeItem, depth: number): JSX.Element => (
    <div key={folder.id}>
      <div className="flex items-center gap-1" style={{ paddingLeft: `${depth * 12}px` }}>
        <FolderIcon size={12} className="text-ink-muted flex-shrink-0" />
        <span>{folder.name}</span>
      </div>
      {(childMap.get(folder.id) ?? []).map(child => renderFolder(child, depth + 1))}
    </div>
  );

  return rootFolders.map(f => renderFolder(f, 0));
}
