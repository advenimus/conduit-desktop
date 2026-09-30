import { useCallback, useState } from "react";
import { EyeIcon, EyeOffIcon } from "../../lib/icons";
import { syncApi, errorText } from "../../lib/sync-api";
import { useEntryStore } from "../../stores/entryStore";
import { useSyncStore } from "../../stores/syncStore";
import { toast } from "../common/Toast";
import type { ConflictVersion, FieldChoiceDto, FieldConflict } from "../../types/sync";
import {
  canUseVersion,
  enteredValueChoice,
  isLongTextField,
  keepBothCopyNames,
  offersEnteredValue,
  versionCaption,
  versionChoice,
  versionText,
  type NameLookup,
} from "./conflict-logic";

const SINGLE_VERSION_KEY_REGS = new Set(["private_key", "totp_secret"]);
const DRAFT_INPUT_CLASS =
  "flex-1 px-2 py-1 text-xs bg-well border border-stroke rounded focus:outline-none focus:ring-2 focus:ring-conduit-500";

/** Folder and item names for Location and Linked credential versions. */
export function useNameLookup(): NameLookup {
  const entries = useEntryStore((s) => s.entries);
  const folders = useEntryStore((s) => s.folders);
  return useCallback(
    (kind, id) => (kind === "folder" ? folders.find((f) => f.id === id)?.name : entries.find((e) => e.id === id)?.name),
    [entries, folders],
  );
}

export function smallButton(primary = false): string {
  return `px-2.5 py-1 text-xs rounded transition-colors disabled:opacity-50 ${
    primary ? "text-white bg-conduit-600 hover:bg-conduit-500" : "text-ink-secondary bg-raised hover:bg-well"
  }`;
}

async function resolveField(field: FieldConflict, choice: FieldChoiceDto, success: string): Promise<boolean> {
  try {
    await useSyncStore.getState().resolve({ kind: "field", key: field.key, choice });
    toast.success(success);
    return true;
  } catch (err) {
    toast.error("Could not save your choice", errorText(err, "Try again."));
    return false;
  }
}

interface VersionLineProps {
  field: FieldConflict;
  version: ConflictVersion;
  busy: boolean;
  names: NameLookup;
  onUse: (v: ConflictVersion) => void;
}

function VersionValue({ field, text }: { field: FieldConflict; text: string }) {
  if (isLongTextField(field)) {
    return (
      <pre className="font-mono text-xs text-ink whitespace-pre-wrap break-words max-h-48 overflow-auto allow-select bg-well/60 rounded px-2 py-1">
        {text}
      </pre>
    );
  }
  return <span className="font-mono text-xs text-ink break-all allow-select">{text}</span>;
}

function VersionLine({ field, version, busy, names, onUse }: VersionLineProps) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const toggleReveal = async () => {
    if (revealed !== null) {
      setRevealed(null);
      return;
    }
    try {
      const res = await syncApi.revealSecret(field.key, version.id);
      setRevealed(res.plaintext ?? "(empty)");
    } catch (err) {
      toast.error("Could not show the value", errorText(err, "Try again."));
    }
  };
  return (
    <div className="flex items-start gap-3 py-2 border-b border-stroke-dim last:border-b-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <VersionValue field={field} text={versionText(field, version, revealed, names)} />
          </div>
          {version.masked && canUseVersion(version) && (
            <button type="button" onClick={() => void toggleReveal()} className="p-0.5 text-ink-muted hover:text-ink" title={revealed === null ? "Show" : "Hide"}>
              {revealed === null ? <EyeIcon size={12} /> : <EyeOffIcon size={12} />}
            </button>
          )}
          {version.provisional && (
            <span className="px-1.5 py-0.5 text-[10px] font-medium text-conduit-400 bg-conduit-500/10 rounded">In use now</span>
          )}
        </div>
        <p className="text-[11px] text-ink-muted mt-0.5">{versionCaption(version)}</p>
      </div>
      {canUseVersion(version) && (
        <button type="button" disabled={busy} onClick={() => onUse(version)} className={smallButton()}>
          Use this
        </button>
      )}
    </div>
  );
}

interface ConflictFieldRowProps {
  field: FieldConflict;
  /** The item's name, for [Keep both] copy names. */
  itemTitle: string;
  /** Hide [Decide later] (inline display in the entry views). */
  compact?: boolean;
}

/** One conflicted field: every version, [Use this], a different value, [Keep both], [Decide later]. */
export default function ConflictFieldRow({ field, itemTitle, compact = false }: ConflictFieldRowProps) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const names = useNameLookup();

  const run = async (choice: FieldChoiceDto, success: string) => {
    setBusy(true);
    const ok = await resolveField(field, choice, success);
    setBusy(false);
    if (ok) setEditing(false);
  };

  const saveDraft = () => {
    const entered = enteredValueChoice(field, draft);
    if (!entered.ok) {
      setDraftError(entered.error);
      return;
    }
    setDraftError(null);
    void run(entered.choice, `${field.label} updated.`);
  };

  const decideLater = async () => {
    setBusy(true);
    try {
      await useSyncStore.getState().snooze(field.snoozeKey);
    } catch (err) {
      toast.error("Could not snooze", errorText(err, "Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-stroke bg-well/40 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-ink">{field.label}</span>
        <span className="text-[11px] text-amber-400">{field.versions.length} versions</span>
      </div>
      {field.staleRevert && <p className="text-xs text-ink-muted">An older Conduit app changed this back to an earlier value.</p>}
      {field.invariantGuard && <p className="text-xs text-ink-muted">Two versions were kept after a repair.</p>}
      {field.secret && SINGLE_VERSION_KEY_REGS.has(field.key.reg) && (
        <p className="text-xs text-amber-400">
          The versions you don't pick are removed from this item. Reveal and copy any key you still need before you choose.
        </p>
      )}
      <div>
        {field.versions.map((v) => (
          <VersionLine
            key={v.id}
            field={field}
            version={v}
            busy={busy}
            names={names}
            onUse={(ver) => void run(versionChoice(ver), `${field.label} resolved.`)}
          />
        ))}
      </div>
      {editing && (
        <div className="flex items-start gap-2">
          {isLongTextField(field) ? (
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus rows={6} className={`${DRAFT_INPUT_CLASS} font-mono`} />
          ) : (
            <input type={field.secret ? "password" : "text"} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus className={DRAFT_INPUT_CLASS} />
          )}
          <button type="button" disabled={busy} onClick={saveDraft} className={smallButton(true)}>Save</button>
          <button type="button" onClick={() => setEditing(false)} className={smallButton()}>Cancel</button>
        </div>
      )}
      {draftError && <p className="text-xs text-red-400">{draftError}</p>}
      <div className="flex flex-wrap gap-2 pt-1">
        {!editing && offersEnteredValue(field) && (
          <button type="button" disabled={busy} onClick={() => setEditing(true)} className={smallButton()}>
            Enter a different value...
          </button>
        )}
        {field.keepBothOffered && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run({ kind: "keep-both", copyNames: keepBothCopyNames(itemTitle, field) }, "Kept both versions.")}
            className={smallButton()}
          >
            Keep both
          </button>
        )}
        {!compact && (
          <button type="button" disabled={busy} onClick={() => void decideLater()} className={smallButton()}>
            Decide later
          </button>
        )}
      </div>
    </div>
  );
}
