import { useState, useCallback } from "react";
import { invoke } from "../../lib/electron";
import { Button, Dialog, Spinner } from "../ui";
import {
  PreviewStep,
  ResultsStep,
  SelectStep,
  groupByFolder,
  type DuplicateStrategy,
  type ImportPreviewEntry,
  type ImportResult,
} from "./ImportSteps";

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

  const importCount = readyCount + decryptFailedCount + duplicateCount;

  const footer =
    step === "select" ? (
      <Button onClick={onClose}>Cancel</Button>
    ) : step === "preview" && !duplicatePrompt ? (
      <>
        <Button onClick={() => { setStep("select"); setPreviewEntries([]); setDuplicatePrompt(false); }}>
          Back
        </Button>
        <Button variant="primary" onClick={handleImportClick} disabled={importCount === 0}>
          Import {importCount} {importCount === 1 ? "Entry" : "Entries"}
        </Button>
      </>
    ) : step === "results" ? (
      <>
        <Button icon="download" onClick={handleSaveLog}>
          Save Log
        </Button>
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      </>
    ) : null;

  return (
    <Dialog
      open
      title="Import from Remote Desktop Manager"
      icon="fileImport"
      onClose={onClose}
      closeOnEscape={canClose}
      closeOnScrim={canClose}
      hideClose={!canClose}
      width={672}
      footer={footer}
    >
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
          <Spinner size={24} className="text-link" />
          <p className="text-ink-muted">Importing entries...</p>
        </div>
      )}

      {step === "results" && result && <ResultsStep result={result} />}
    </Dialog>
  );
}
