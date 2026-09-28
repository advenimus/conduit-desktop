import { useState, useCallback, type JSX } from "react";
import { invoke } from "../../lib/electron";
import {
  CheckIcon, DesktopIcon, FileImportIcon, FolderIcon, GlobeWwwIcon, KeyIcon, LockIcon, ServerIcon, TerminalIcon
} from "../../lib/icons";
import { Button, Callout, Dialog, FormField, IconButton, Spinner, TextInput } from "../ui";

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

  const footer =
    step === "file" ? (
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={handleDecrypt} disabled={!filePath || !passphrase} loading={loading} loadingLabel="Decrypting...">
          Continue
        </Button>
      </>
    ) : step === "preview" ? (
      <>
        <Button
          onClick={() => {
            setStep("file");
            setPreview(null);
            setError(null);
          }}
        >
          Back
        </Button>
        <Button variant="primary" onClick={handleImport}>
          Import {preview ? preview.entry_count : 0} Entries
        </Button>
      </>
    ) : step === "results" ? (
      <Button variant="primary" onClick={onClose}>
        Done
      </Button>
    ) : null;

  return (
    <Dialog
      open
      title="Import from Export"
      icon="upload"
      width={512}
      onClose={onClose}
      closeOnEscape={canClose}
      closeOnScrim={canClose}
      hideClose={!canClose}
      footer={footer}
    >
      {step === "file" && (
        <div className="space-y-4">
          <div>
            <label className="block text-label font-semibold text-ink-secondary mb-1">Export File</label>
            <button
              type="button"
              onClick={handlePickFile}
              className="w-full flex items-center gap-2 h-control px-2 rounded border border-input-border bg-input hover:bg-hover text-left"
            >
              <FileImportIcon size={16} className="text-ink-muted flex-shrink-0" />
              <span className={filePath ? "truncate text-ink" : "truncate text-ink-muted"}>
                {filePath ? filePath.split(/[/\\]/).pop() : "Choose .conduit-export file..."}
              </span>
            </button>
          </div>

          <FormField
            label={
              <span className="inline-flex items-center gap-1">
                <LockIcon size={16} />
                Export Passphrase
              </span>
            }
          >
            <TextInput
              type={showPassphrase ? "text" : "password"}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Enter the passphrase used during export"
              onKeyDown={(e) => {
                if (e.key === "Enter" && filePath && passphrase) handleDecrypt();
              }}
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

          {error && (
            <Callout tone="danger" icon="alertTriangle">
              {error}
            </Callout>
          )}
        </div>
      )}

      {step === "preview" && preview && (
        <div className="space-y-4">
          <div className="p-3 rounded-md bg-well space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-ink-muted">Source Vault</span>
              <span className="font-medium text-ink">{preview.source_vault_name}</span>
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

          <div className="flex flex-wrap gap-3">
            <span className="flex items-center gap-1">
              <FolderIcon size={16} className="text-ink-muted" />
              {preview.folder_count} folders
            </span>
            {Object.entries(preview.entry_type_counts).map(([type, count]) => (
              <span key={type} className="flex items-center gap-1">
                <EntryTypeIcon type={type} />
                {count} {type}
              </span>
            ))}
          </div>

          {preview.folder_tree.length > 0 && (
            <div>
              <label className="block text-label font-semibold text-ink-secondary mb-1">Folder Structure</label>
              <div className="p-2 rounded-md bg-well text-label space-y-0.5 max-h-32 overflow-y-auto">
                {renderFolderTree(preview.folder_tree)}
              </div>
            </div>
          )}

          {placementNote && (
            <p className="text-meta text-ink-faint">
              {placementNote}
            </p>
          )}

          {error && (
            <Callout tone="danger" icon="alertTriangle">
              {error}
            </Callout>
          )}
        </div>
      )}

      {step === "importing" && <WorkingState text="Importing entries and folders..." />}

      {step === "results" && result && (
        <div className="space-y-4">
          <ResultSummary
            title="Import Complete"
            counts={[
              { value: result.foldersCreated, label: "Folders Created" },
              { value: result.entriesCreated, label: "Entries Created" },
            ]}
          />

          {(result.credentialRefsRemapped > 0 || result.credentialRefsCleared > 0) && (
            <div className="text-meta text-ink-muted space-y-0.5">
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
    </Dialog>
  );
}

/** The busy state of the export and import dialogs while they cannot be closed. */
export function WorkingState({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-8">
      <Spinner size={24} className="text-info" />
      <p className="text-ink-muted">{text}</p>
    </div>
  );
}

/** The success tick and the two count tiles the export and import dialogs end on. */
export function ResultSummary({ title, counts }: { title: string; counts: ReadonlyArray<{ value: number; label: string }> }) {
  return (
    <>
      <div className="flex flex-col items-center gap-2 py-4">
        <div className="size-10 rounded-full bg-success-bg flex items-center justify-center">
          <CheckIcon size={24} className="text-success" />
        </div>
        <p className="font-semibold text-ink">{title}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 text-center">
        {counts.map((count) => (
          <div key={count.label} className="p-3 rounded-md bg-well">
            <div className="text-title font-semibold text-info">{count.value}</div>
            <div className="text-meta text-ink-muted">{count.label}</div>
          </div>
        ))}
      </div>
    </>
  );
}

// ── Helpers ──────────────────────────────────────────────────────

function EntryTypeIcon({ type }: { type: string }) {
  const props = { size: 16, stroke: 1.5, className: "text-ink-muted" };
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
