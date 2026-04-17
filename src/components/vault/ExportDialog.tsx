import { useState, useCallback, useMemo } from "react";
import { invoke } from "../../lib/electron";
import { useEntryStore } from "../../stores/entryStore";
import {
  AlertTriangleIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon, DownloadIcon, EyeIcon, EyeOffIcon, FolderIcon, FolderOpenIcon, LoaderIcon, LockIcon
} from "../../lib/icons";

type Step = "configure" | "exporting" | "complete";

interface Props {
  onClose: () => void;
}

export default function ExportDialog({ onClose }: Props) {
  const [step, setStep] = useState<Step>("configure");
  const [scope, setScope] = useState<"full" | "folder">("full");
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(new Set());
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultCounts, setResultCounts] = useState<{ folderCount: number; entryCount: number } | null>(null);
  const [outputPath, setOutputPath] = useState<string | null>(null);

  const folders = useEntryStore((s) => s.folders);

  const canClose = step !== "exporting";
  const passphraseMismatch = confirmPassphrase.length > 0 && passphrase !== confirmPassphrase;
  const passphraseWeak = passphrase.length > 0 && passphrase.length < 8;
  const canExport =
    passphrase.length >= 8 &&
    passphrase === confirmPassphrase &&
    (scope === "full" || selectedFolderIds.size > 0);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && canClose) onClose();
  };

  const toggleFolder = useCallback((folderId: string) => {
    setSelectedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }, []);

  const handleExport = useCallback(async () => {
    if (!canExport) return;
    setError(null);

    try {
      // Pick save location
      const path = await invoke<string | null>("export_pick_file");
      if (!path) return;

      setStep("exporting");
      setOutputPath(path);

      const result = await invoke<{ folderCount: number; entryCount: number }>("export_execute", {
        scope,
        folderIds: scope === "folder" ? [...selectedFolderIds] : undefined,
        passphrase,
        outputPath: path,
      });

      setResultCounts(result);
      setPassphrase("");
      setConfirmPassphrase("");
      setStep("complete");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep("configure");
    }
  }, [canExport, scope, selectedFolderIds, passphrase]);

  // Build folder tree for picker
  const folderTree = useMemo(() => buildFolderTree(folders), [folders]);

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/50 z-50"
      onKeyDown={handleKeyDown}
      onClick={(e) => {
        if (e.target === e.currentTarget && canClose) onClose();
      }}
    >
      <div data-dialog-content className="w-full max-w-md bg-panel rounded-lg shadow-xl flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-stroke flex-shrink-0">
          <div className="flex items-center gap-2">
            <DownloadIcon size={20} className="text-conduit-400" />
            <h2 className="text-lg font-semibold">Export Vault</h2>
          </div>
          {canClose && (
            <button onClick={onClose} className="p-1 hover:bg-raised rounded">
              <CloseIcon size={18} />
            </button>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {step === "configure" && (
            <div className="space-y-4">
              {/* Scope selector */}
              <div>
                <label className="block text-sm font-medium mb-2">What to Export</label>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 p-2.5 rounded border border-stroke cursor-pointer hover:bg-well has-[:checked]:border-conduit-500 has-[:checked]:bg-conduit-500/10">
                    <input
                      type="radio"
                      name="scope"
                      checked={scope === "full"}
                      onChange={() => setScope("full")}
                      className="accent-conduit-500"
                    />
                    <div>
                      <div className="text-sm font-medium">Entire Vault</div>
                      <div className="text-xs text-ink-muted">All folders and entries</div>
                    </div>
                  </label>
                  <label className="flex items-center gap-2 p-2.5 rounded border border-stroke cursor-pointer hover:bg-well has-[:checked]:border-conduit-500 has-[:checked]:bg-conduit-500/10">
                    <input
                      type="radio"
                      name="scope"
                      checked={scope === "folder"}
                      onChange={() => setScope("folder")}
                      className="accent-conduit-500"
                    />
                    <div>
                      <div className="text-sm font-medium">Select Folders</div>
                      <div className="text-xs text-ink-muted">Choose specific folders to export</div>
                    </div>
                  </label>
                </div>
              </div>

              {/* Folder picker (only when scope is folder) */}
              {scope === "folder" && (
                <div>
                  <label className="block text-xs font-medium text-ink-muted mb-1.5">
                    Select folders to export ({selectedFolderIds.size} selected)
                  </label>
                  <div className="rounded border border-stroke bg-canvas max-h-48 overflow-y-auto">
                    {folderTree.length > 0 ? (
                      <div className="py-1">
                        {folderTree.map((node) => (
                          <FolderPickerNode
                            key={node.id}
                            node={node}
                            depth={0}
                            selectedIds={selectedFolderIds}
                            onToggle={toggleFolder}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="py-4 text-center text-sm text-ink-faint">
                        No folders in vault
                      </div>
                    )}
                  </div>
                </div>
              )}

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
                    placeholder="Enter a passphrase to encrypt the export"
                    className="w-full px-3 py-2 pr-9 text-sm rounded border border-stroke bg-canvas focus:border-conduit-500 focus:outline-none"
                    autoFocus={scope === "full"}
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
                {passphraseWeak && (
                  <p className="text-xs text-amber-400 mt-1">Passphrase should be at least 8 characters</p>
                )}
              </div>

              {/* Confirm passphrase */}
              <div>
                <label className="block text-sm font-medium mb-1.5">Confirm Passphrase</label>
                <input
                  type={showPassphrase ? "text" : "password"}
                  value={confirmPassphrase}
                  onChange={(e) => setConfirmPassphrase(e.target.value)}
                  placeholder="Re-enter passphrase"
                  className={`w-full px-3 py-2 text-sm rounded border bg-canvas focus:outline-none ${
                    passphraseMismatch ? "border-red-500" : "border-stroke focus:border-conduit-500"
                  }`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canExport) handleExport();
                  }}
                />
                {passphraseMismatch && (
                  <p className="text-xs text-red-400 mt-1">Passphrases do not match</p>
                )}
              </div>

              <p className="text-xs text-ink-faint">
                Share this passphrase securely with anyone who needs to import this file. It cannot be recovered.
              </p>

              {error && (
                <div className="flex items-start gap-2 p-3 rounded bg-red-500/10 text-red-400 text-sm">
                  <AlertTriangleIcon size={16} className="flex-shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}
            </div>
          )}

          {step === "exporting" && (
            <div className="flex flex-col items-center gap-3 py-8">
              <LoaderIcon size={32} className="text-conduit-400 animate-spin" />
              <p className="text-ink-muted text-sm">Exporting and encrypting vault data...</p>
            </div>
          )}

          {step === "complete" && resultCounts && (
            <div className="space-y-4">
              <div className="flex flex-col items-center gap-2 py-4">
                <div className="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center">
                  <CheckIcon size={24} className="text-green-400" />
                </div>
                <p className="text-sm font-medium">Export Complete</p>
              </div>

              <div className="grid grid-cols-2 gap-3 text-center">
                <div className="p-3 rounded bg-well">
                  <div className="text-xl font-bold text-conduit-400">{resultCounts.folderCount}</div>
                  <div className="text-xs text-ink-muted">Folders</div>
                </div>
                <div className="p-3 rounded bg-well">
                  <div className="text-xl font-bold text-conduit-400">{resultCounts.entryCount}</div>
                  <div className="text-xs text-ink-muted">Entries</div>
                </div>
              </div>

              {outputPath && (
                <p className="text-xs text-ink-faint break-all">
                  Saved to: {outputPath}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-stroke flex-shrink-0">
          {step === "configure" && (
            <>
              <button onClick={onClose} className="px-4 py-2 text-sm rounded hover:bg-raised">
                Cancel
              </button>
              <button
                onClick={handleExport}
                disabled={!canExport}
                className="px-4 py-2 text-sm rounded bg-conduit-600 hover:bg-conduit-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Export
              </button>
            </>
          )}

          {step === "complete" && (
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

// ── Folder tree picker ──────────────────────────────────────────────

interface FolderTreeNode {
  id: string;
  name: string;
  children: FolderTreeNode[];
}

function buildFolderTree(
  folders: Array<{ id: string; name: string; parent_id: string | null }>,
): FolderTreeNode[] {
  const childMap = new Map<string | null, typeof folders>();
  for (const f of folders) {
    const key = f.parent_id ?? null;
    const list = childMap.get(key) ?? [];
    list.push(f);
    childMap.set(key, list);
  }

  const build = (parentId: string | null): FolderTreeNode[] => {
    const children = childMap.get(parentId) ?? [];
    return children
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => ({
        id: f.id,
        name: f.name,
        children: build(f.id),
      }));
  };

  return build(null);
}

function FolderPickerNode({
  node,
  depth,
  selectedIds,
  onToggle,
}: {
  node: FolderTreeNode;
  depth: number;
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const isSelected = selectedIds.has(node.id);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div
        className="flex items-center gap-1.5 px-2 py-1 hover:bg-well cursor-pointer text-sm"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => onToggle(node.id)}
      >
        {hasChildren ? (
          <button
            className="p-0.5 flex-shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
          >
            {expanded ? (
              <ChevronDownIcon size={12} className="text-ink-muted" />
            ) : (
              <ChevronRightIcon size={12} className="text-ink-muted" />
            )}
          </button>
        ) : (
          <span className="w-[18px] flex-shrink-0" />
        )}
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggle(node.id)}
          onClick={(e) => e.stopPropagation()}
          className="accent-conduit-500 flex-shrink-0"
        />
        {expanded && hasChildren ? (
          <FolderOpenIcon size={14} className="text-ink-muted flex-shrink-0" />
        ) : (
          <FolderIcon size={14} className="text-ink-muted flex-shrink-0" />
        )}
        <span className="truncate">{node.name}</span>
      </div>
      {expanded && hasChildren && (
        <div>
          {node.children.map((child) => (
            <FolderPickerNode
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedIds={selectedIds}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}
