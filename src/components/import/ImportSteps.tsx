import {
  AlertTriangleIcon, BanIcon, CheckIcon, CopyIcon, FileImportIcon, FileTextIcon, FolderIcon, GlobeWwwIcon, KeyIcon, ServerAltIcon, ServerIcon, TerminalIcon
} from "../../lib/icons";
import { Button, Callout, cx } from "../ui";

export interface ImportPreviewEntry {
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

export type DuplicateStrategy = "overwrite" | "skip";

export interface ImportEntryResult {
  name: string;
  conduitType: string;
  status: "imported" | "skipped" | "error" | "overwritten";
  message: string;
}

export interface ImportResult {
  totalParsed: number;
  imported: number;
  skipped: number;
  errors: number;
  entries: ImportEntryResult[];
}

export function SelectStep({
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
      <p className="text-ink-muted">
        Select a <code className="rounded bg-code px-1 py-0.5 text-label">.rdm</code> export file
        from Devolutions Remote Desktop Manager. Credentials will be decrypted automatically.
      </p>

      <div>
        <label className="mb-1.5 block text-label font-semibold text-ink-secondary">Export File</label>
        <button
          type="button"
          onClick={onPickFile}
          disabled={loading}
          className="flex h-control w-full items-center gap-2 rounded border border-input-border bg-input px-1.5 text-left text-body hover:bg-hover disabled:opacity-40"
        >
          <FileImportIcon size={16} className="shrink-0 text-ink-muted" />
          <span className={filePath ? "text-ink" : "text-ink-muted"}>
            {loading ? "Parsing..." : filePath ? filePath.split(/[/\\]/).pop() : "Choose file..."}
          </span>
        </button>
      </div>

      {error && <Callout tone="danger">{error}</Callout>}
    </div>
  );
}

export function PreviewStep({
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
      <div className="flex flex-wrap gap-3">
        <span className="flex items-center gap-1 text-success">
          <CheckIcon size={14} />
          {readyCount} ready
        </span>
        {decryptFailedCount > 0 && (
          <span className="flex items-center gap-1 text-warning">
            <AlertTriangleIcon size={14} />
            {decryptFailedCount} credential{decryptFailedCount !== 1 ? "s" : ""} could not be decrypted
          </span>
        )}
        {duplicateCount > 0 && (
          <span className="flex items-center gap-1 text-warning">
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
          <span className="flex items-center gap-1 text-danger">
            <BanIcon size={14} />
            {tierLimitCount} tier limit
          </span>
        )}
      </div>

      {error && <Callout tone="danger">{error}</Callout>}

      {duplicatePrompt && (
        <Callout
          tone="warning"
          actions={
            <>
              <Button size="sm" variant="primary" onClick={() => onDuplicateStrategy("overwrite")}>
                Overwrite All
              </Button>
              <Button size="sm" onClick={() => onDuplicateStrategy("skip")}>
                Skip All
              </Button>
            </>
          }
        >
          {duplicateCount} {duplicateCount === 1 ? "entry already exists" : "entries already exist"} in your vault.
        </Callout>
      )}

      <div className="max-h-[40vh] space-y-3 overflow-y-auto">
        {Array.from(groupedEntries.entries()).map(([folder, entries]) => (
          <div key={folder}>
            <div className="mb-1 flex items-center gap-1.5 font-medium text-ink-muted">
              <FolderIcon size={14} />
              {folder || "Root"}
            </div>
            <div className="ml-4 space-y-0.5">
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
    <div className="flex h-row items-center gap-2 rounded px-2 hover:bg-hover">
      <TypeIcon size={14} className="shrink-0 text-ink-muted" />
      <span className="flex-1 truncate">{entry.name}</span>
      {entry.host && <span className="max-w-[140px] truncate text-label text-ink-muted">{entry.host}</span>}
      <StatusBadge status={entry.status} />
    </div>
  );
}

function StatusBadge({ status }: { status: ImportPreviewEntry["status"] }) {
  switch (status) {
    case "ready":
      return (
        <span className="flex items-center gap-0.5 text-success">
          <CheckIcon size={12} />
        </span>
      );
    case "duplicate":
      return (
        <span className="flex items-center gap-0.5 text-warning" title="Duplicate entry">
          <CopyIcon size={12} />
        </span>
      );
    case "decrypt-failed":
      return (
        <span className="flex items-center gap-0.5 text-warning" title="Password decryption failed">
          <AlertTriangleIcon size={12} />
        </span>
      );
    case "unsupported":
      return (
        <span className="flex items-center gap-0.5 text-ink-muted" title="Unsupported type">
          <BanIcon size={12} />
        </span>
      );
    case "tier-limit":
      return (
        <span className="flex items-center gap-0.5 text-danger" title="Tier limit">
          <BanIcon size={12} />
        </span>
      );
  }
}

const RESULT_TILES = [
  { key: "imported", label: "Imported", tile: "bg-success-bg", number: "text-success" },
  { key: "skipped", label: "Skipped", tile: "bg-warning-bg", number: "text-warning" },
  { key: "errors", label: "Errors", tile: "bg-danger-bg", number: "text-danger" },
] as const;

export function ResultsStep({ result }: { result: ImportResult }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3 text-center">
        {RESULT_TILES.map((t) => (
          <div key={t.key} className={cx("rounded p-3", t.tile)}>
            <div className={cx("text-display", t.number)}>{result[t.key]}</div>
            <div className="text-label text-ink-muted">{t.label}</div>
          </div>
        ))}
      </div>

      <div className="max-h-[35vh] space-y-0.5 overflow-y-auto">
        {result.entries.map((entry, i) => (
          <div key={i} className={cx("flex items-center gap-2 rounded px-2 py-1.5", entry.status === "error" && "bg-danger-bg")}>
            <ResultIcon status={entry.status} />
            <span className="w-16 shrink-0 text-label text-ink-muted">{entry.conduitType}</span>
            <span className="flex-1 truncate">{entry.name}</span>
            <span className="max-w-[200px] truncate text-label text-ink-muted">{entry.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ResultIcon({ status }: { status: ImportEntryResult["status"] }) {
  switch (status) {
    case "imported":
      return <CheckIcon size={14} className="shrink-0 text-success" />;
    case "overwritten":
      return <CopyIcon size={14} className="shrink-0 text-info" />;
    case "skipped":
      return <BanIcon size={14} className="shrink-0 text-warning" />;
    case "error":
      return <AlertTriangleIcon size={14} className="shrink-0 text-danger" />;
  }
}

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

export function groupByFolder(entries: ImportPreviewEntry[]): Map<string, ImportPreviewEntry[]> {
  const map = new Map<string, ImportPreviewEntry[]>();

  for (const entry of entries) {
    // Skip pure folder entries (no credentials)
    if (entry.conduitType === "folder" && !entry.isGroupCredential) continue;

    const folder = entry.folderPath ?? "";
    map.set(folder, [...(map.get(folder) ?? []), entry]);
  }

  return map;
}
