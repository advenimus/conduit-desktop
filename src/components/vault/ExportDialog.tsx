import { useState, useCallback, useMemo } from "react";
import { invoke } from "../../lib/electron";
import { useEntryStore } from "../../stores/entryStore";
import { FolderIcon, FolderOpenIcon, LockIcon } from "../../lib/icons";
import { Button, Callout, Dialog, FormField, IconButton, TextInput } from "../ui";
import { ResultSummary, WorkingState } from "./VaultImportDialog";

const SCOPE_CARD =
  "flex items-center gap-2 p-2.5 rounded-md border border-card-border cursor-pointer hover:bg-hover has-[:checked]:border-accent has-[:checked]:bg-selected-inactive";

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

  const footer =
    step === "configure" ? (
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={handleExport} disabled={!canExport}>
          Export
        </Button>
      </>
    ) : step === "complete" ? (
      <Button variant="primary" onClick={onClose}>
        Done
      </Button>
    ) : null;

  return (
    <Dialog
      open
      title="Export Vault"
      icon="download"
      width={448}
      onClose={onClose}
      closeOnEscape={canClose}
      closeOnScrim={canClose}
      hideClose={!canClose}
      footer={footer}
    >
      {step === "configure" && (
        <div className="space-y-4">
          <div>
            <label className="block text-label font-semibold text-ink-secondary mb-2">What to Export</label>
            <div className="space-y-2">
              <label className={SCOPE_CARD}>
                <input
                  type="radio"
                  name="scope"
                  checked={scope === "full"}
                  onChange={() => setScope("full")}
                  className="accent-(--c-accent)"
                />
                <div>
                  <div className="font-medium text-ink">Entire Vault</div>
                  <div className="text-meta text-ink-muted">All folders and entries</div>
                </div>
              </label>
              <label className={SCOPE_CARD}>
                <input
                  type="radio"
                  name="scope"
                  checked={scope === "folder"}
                  onChange={() => setScope("folder")}
                  className="accent-(--c-accent)"
                />
                <div>
                  <div className="font-medium text-ink">Select Folders</div>
                  <div className="text-meta text-ink-muted">Choose specific folders to export</div>
                </div>
              </label>
            </div>
          </div>

          {scope === "folder" && (
            <div>
              <label className="block text-label font-semibold text-ink-secondary mb-1">
                Select folders to export ({selectedFolderIds.size} selected)
              </label>
              <div className="rounded border border-input-border bg-input max-h-48 overflow-y-auto">
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
                  <div className="py-4 text-center text-ink-faint">
                    No folders in vault
                  </div>
                )}
              </div>
            </div>
          )}

          <FormField
            label={
              <span className="inline-flex items-center gap-1">
                <LockIcon size={16} />
                Export Passphrase
              </span>
            }
            description={passphraseWeak ? <span className="text-warning">Passphrase should be at least 8 characters</span> : undefined}
          >
            <TextInput
              type={showPassphrase ? "text" : "password"}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Enter a passphrase to encrypt the export"
              autoFocus={scope === "full"}
              trailing={
                <IconButton
                  size="sm"
                  icon={showPassphrase ? "eyeOff" : "eye"}
                  label={showPassphrase ? "Hide passphrase" : "Show passphrase"}
                  onClick={() => setShowPassphrase(!showPassphrase)}
                  tabIndex={-1}
                />
              }
            />
          </FormField>

          <FormField label="Confirm Passphrase" error={passphraseMismatch ? "Passphrases do not match" : undefined}>
            <TextInput
              type={showPassphrase ? "text" : "password"}
              value={confirmPassphrase}
              onChange={(e) => setConfirmPassphrase(e.target.value)}
              placeholder="Re-enter passphrase"
              invalid={passphraseMismatch}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canExport) handleExport();
              }}
            />
          </FormField>

          <p className="text-meta text-ink-faint">
            Share this passphrase securely with anyone who needs to import this file. It cannot be recovered.
          </p>

          {error && (
            <Callout tone="danger" icon="alertTriangle">
              {error}
            </Callout>
          )}
        </div>
      )}

      {step === "exporting" && <WorkingState text="Exporting and encrypting vault data..." />}

      {step === "complete" && resultCounts && (
        <div className="space-y-4">
          <ResultSummary
            title="Export Complete"
            counts={[
              { value: resultCounts.folderCount, label: "Folders" },
              { value: resultCounts.entryCount, label: "Entries" },
            ]}
          />

          {outputPath && (
            <p className="text-meta text-ink-faint break-all">
              Saved to: {outputPath}
            </p>
          )}
        </div>
      )}
    </Dialog>
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
        className="flex h-row items-center gap-1.5 pr-2 hover:bg-hover cursor-pointer"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => onToggle(node.id)}
      >
        {hasChildren ? (
          <IconButton
            size="sm"
            icon={expanded ? "chevronDown" : "chevronRight"}
            label={expanded ? "Collapse" : "Expand"}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
          />
        ) : (
          <span className="w-5 flex-shrink-0" />
        )}
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggle(node.id)}
          onClick={(e) => e.stopPropagation()}
          className="accent-(--c-accent) flex-shrink-0"
        />
        {expanded && hasChildren ? (
          <FolderOpenIcon size={16} className="text-ink-muted flex-shrink-0" />
        ) : (
          <FolderIcon size={16} className="text-ink-muted flex-shrink-0" />
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
