import { useCallback, useState } from "react";
import { Badge, IconButton, Textarea, TextInput } from "../ui";
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

import SmallButton from "./SmallButton";

export { smallButton } from "./SmallButton";

const SINGLE_VERSION_KEY_REGS = new Set(["private_key", "totp_secret"]);

/** Folder and item names for Location and Linked credential versions. */
export function useNameLookup(): NameLookup {
  const entries = useEntryStore((s) => s.entries);
  const folders = useEntryStore((s) => s.folders);
  return useCallback(
    (kind, id) => (kind === "folder" ? folders.find((f) => f.id === id)?.name : entries.find((e) => e.id === id)?.name),
    [entries, folders],
  );
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
      <pre data-cv-review-value="" className="allow-select max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-code px-2 py-1 font-mono text-label text-ink">
        {text}
      </pre>
    );
  }
  return (
    <span data-cv-review-value="" className="allow-select break-all font-mono text-label text-ink">
      {text}
    </span>
  );
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
    <div data-cv-review-version="" className="flex items-start gap-3 border-b border-stroke-dim py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <VersionValue field={field} text={versionText(field, version, revealed, names)} />
          </div>
          {version.masked && canUseVersion(version) && (
            <IconButton size="sm" icon={revealed === null ? "eye" : "eyeOff"} label={revealed === null ? "Show" : "Hide"} onClick={() => void toggleReveal()} />
          )}
          {version.provisional && (
            <Badge tone="accent" className="shrink-0">In use now</Badge>
          )}
        </div>
        <p className="mt-0.5 text-meta text-ink-muted">{versionCaption(version)}</p>
      </div>
      {canUseVersion(version) && (
        <SmallButton disabled={busy} onClick={() => onUse(version)}>
          Use this
        </SmallButton>
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
    <div data-cv-review-field="" className="space-y-2 rounded-md border border-card-border bg-well p-3">
      <div className="flex items-center justify-between gap-2">
        <span data-cv-review-field-label="" className="text-body font-semibold text-ink">{field.label}</span>
        <span className="text-meta text-warning">{field.versions.length} versions</span>
      </div>
      {field.staleRevert && <p className="text-label text-ink-muted">An older Conduit app changed this back to an earlier value.</p>}
      {field.invariantGuard && <p className="text-label text-ink-muted">Two versions were kept after a repair.</p>}
      {field.secret && SINGLE_VERSION_KEY_REGS.has(field.key.reg) && (
        <p className="text-label text-warning">
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
          <div className="min-w-0 flex-1">
            {isLongTextField(field) ? (
              <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus rows={6} className="font-mono" />
            ) : (
              <TextInput type={field.secret ? "password" : "text"} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
            )}
          </div>
          <SmallButton primary disabled={busy} onClick={saveDraft}>Save</SmallButton>
          <SmallButton onClick={() => setEditing(false)}>Cancel</SmallButton>
        </div>
      )}
      {draftError && <p data-cv-error="" className="text-label text-danger">{draftError}</p>}
      <div className="flex flex-wrap gap-2 pt-1">
        {!editing && offersEnteredValue(field) && (
          <SmallButton disabled={busy} onClick={() => setEditing(true)}>
            Enter a different value...
          </SmallButton>
        )}
        {field.keepBothOffered && (
          <SmallButton disabled={busy} onClick={() => void run({ kind: "keep-both", copyNames: keepBothCopyNames(itemTitle, field) }, "Kept both versions.")}>
            Keep both
          </SmallButton>
        )}
        {!compact && (
          <SmallButton disabled={busy} onClick={() => void decideLater()}>
            Decide later
          </SmallButton>
        )}
      </div>
    </div>
  );
}
