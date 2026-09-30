import { useState, type ReactNode } from "react";
import { syncApi, errorText } from "../../lib/sync-api";
import { useSyncStore } from "../../stores/syncStore";
import { useEntryStore } from "../../stores/entryStore";
import { toast } from "../common/Toast";
import type { ConflictItem, ResolveRequest } from "../../types/sync";
import ConflictFieldRow, { smallButton } from "./ConflictFieldRow";
import { InlineError } from "./PasswordFields";
import {
  appearanceRequest,
  canUseVersion,
  cycleText,
  editDeleteText,
  folderDeleteText,
  initialAppearanceSelections,
  versionCaption,
  versionText,
} from "./conflict-logic";

type Item<K extends ConflictItem["kind"]> = Extract<ConflictItem, { kind: K }>;

async function runResolve(request: ResolveRequest, success: string): Promise<void> {
  try {
    await useSyncStore.getState().resolve(request);
    toast.success(success);
  } catch (err) {
    toast.error("Could not save your choice", errorText(err, "Try again."));
  }
}

function ItemBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-stroke bg-well/40 p-3 space-y-2">
      <p className="text-sm font-medium text-ink">{title}</p>
      {children}
    </div>
  );
}

function AppearanceView({ item }: { item: Item<"appearance"> }) {
  const [selections, setSelections] = useState(() => initialAppearanceSelections(item));
  const [busy, setBusy] = useState(false);
  const apply = async () => {
    setBusy(true);
    try {
      await useSyncStore.getState().resolveGroup(appearanceRequest(item, selections));
      toast.success("Appearance resolved.");
    } catch (err) {
      toast.error("Could not save your choice", errorText(err, "Try again."));
    } finally {
      setBusy(false);
    }
  };
  const later = () => void useSyncStore.getState().snooze(item.snoozeKey).catch((err) => toast.error("Could not snooze", errorText(err, "Try again.")));
  return (
    <ItemBox title="Appearance">
      <p className="text-xs text-ink-muted">Keep newest is selected. Change any choice, then Apply.</p>
      {item.fields.map((f) => (
        <div key={f.key.reg} className="space-y-1">
          <p className="text-xs font-medium text-ink-secondary">{f.label}</p>
          {f.versions.filter(canUseVersion).map((v) => (
            <label key={v.id} className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="radio"
                name={`${item.snoozeKey}-${f.key.reg}`}
                checked={selections[f.key.reg] === v.id}
                onChange={() => setSelections({ ...selections, [f.key.reg]: v.id })}
                className="accent-conduit-500"
              />
              <span className="font-mono text-ink">{versionText(f, v)}</span>
              <span className="text-ink-muted">{versionCaption(v)}</span>
            </label>
          ))}
        </div>
      ))}
      <div className="flex gap-2 pt-1">
        <button type="button" disabled={busy} onClick={() => void apply()} className={smallButton(true)}>Apply</button>
        <button type="button" disabled={busy} onClick={later} className={smallButton()}>Decide later</button>
      </div>
    </ItemBox>
  );
}

function EditDeleteView({ item }: { item: Item<"edit-delete"> }) {
  return (
    <ItemBox title="Deleted and edited">
      <p className="text-xs text-ink-secondary">{editDeleteText(item)}</p>
      <div className="flex gap-2">
        <button type="button" onClick={() => void runResolve({ kind: "edit-delete", row: item.row, choice: "keep" }, "Item kept.")} className={smallButton(true)}>Keep item</button>
        <button type="button" onClick={() => void runResolve({ kind: "edit-delete", row: item.row, choice: "delete" }, "Item deleted.")} className={smallButton()}>Delete item</button>
      </div>
    </ItemBox>
  );
}

function FolderDeleteView({ item, title }: { item: Item<"folder-delete">; title: string }) {
  const choose = (choice: "keep-with-changed" | "delete-all" | "restore-all", done: string) =>
    void runResolve({ kind: "folder-delete", folder: item.folder, choice }, done);
  return (
    <ItemBox title="Folder deleted">
      <p className="text-xs text-ink-secondary">{folderDeleteText(item, title)}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => choose("keep-with-changed", "Folder kept with changed items.")} className={smallButton(true)}>Keep folder with changed items</button>
        <button type="button" onClick={() => choose("delete-all", "Folder deleted.")} className={smallButton()}>Delete folder and items</button>
        <button type="button" onClick={() => choose("restore-all", "Folder restored.")} className={smallButton()}>Restore everything in folder</button>
      </div>
    </ItemBox>
  );
}

function useRowNames(tbl: 1 | 2, rowIds: readonly string[]): string[] {
  const entries = useEntryStore((s) => s.entries);
  const folders = useEntryStore((s) => s.folders);
  return rowIds.map((id) => (tbl === 2 ? folders.find((f) => f.id === id)?.name : entries.find((e) => e.id === id)?.name) ?? "an item");
}

function CycleView({ item }: { item: Item<"cycle"> }) {
  const names = useRowNames(item.tbl, item.rowIds);
  const [a, b] = item.rowIds;
  const request = (choice: Extract<ResolveRequest, { kind: "cycle" }>["choice"]): ResolveRequest => ({ kind: "cycle", tbl: item.tbl, rowIds: item.rowIds, choice });
  return (
    <ItemBox title="Moved into each other">
      <p className="text-xs text-ink-secondary">{cycleText(item, names)}</p>
      <div className="flex flex-wrap gap-2">
        {a && b && item.rowIds.length === 2 && (
          <>
            <button type="button" onClick={() => void runResolve(request({ kind: "put-under", child: a, parent: b }), "Moved.")} className={smallButton()}>Put {names[0]} in {names[1]}</button>
            <button type="button" onClick={() => void runResolve(request({ kind: "put-under", child: b, parent: a }), "Moved.")} className={smallButton()}>Put {names[1]} in {names[0]}</button>
          </>
        )}
        <button type="button" onClick={() => void runResolve(request({ kind: "all-root" }), "Moved to the top level.")} className={smallButton(true)}>All at top level</button>
      </div>
    </ItemBox>
  );
}

function UndecryptableView({ item }: { item: Item<"undecryptable"> }) {
  const field = item.field;
  const locked = field.versions.find((v) => v.undecryptable) ?? null;
  const [oldPassword, setOldPassword] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recover = async () => {
    if (!locked) return;
    setError(null);
    try {
      const res = await syncApi.recoverUndecryptable(field.key, locked.id, oldPassword);
      if (!res.ok) {
        setError("That password didn't work.");
        return;
      }
      toast.success(`${field.label} recovered.`);
      await useSyncStore.getState().loadConflicts();
    } catch (err) {
      setError(errorText(err, "Could not recover the value."));
    }
  };
  const who = locked ? versionCaption(locked) : "another device";
  return (
    <ItemBox title={field.label}>
      <p className="text-xs text-ink-secondary">A value saved on {who} used your old master password.</p>
      {asking && (
        <input
          type="password"
          value={oldPassword}
          onChange={(e) => setOldPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && oldPassword.length > 0) void recover();
          }}
          placeholder="Old master password"
          autoFocus
          className="w-full px-2 py-1 text-xs bg-well border border-stroke rounded focus:outline-none focus:ring-2 focus:ring-conduit-500"
        />
      )}
      <InlineError message={error} />
      <div className="flex gap-2">
        {asking ? (
          <button type="button" disabled={oldPassword.length === 0} onClick={() => void recover()} className={smallButton(true)}>Recover</button>
        ) : (
          <button type="button" onClick={() => setAsking(true)} className={smallButton(true)}>Enter old password</button>
        )}
        <button type="button" onClick={() => void runResolve({ kind: "undecryptable-discard", key: field.key }, "Value discarded.")} className={smallButton()}>Discard</button>
      </div>
    </ItemBox>
  );
}

/** One conflict item of a group, by kind. */
export default function ConflictItemView({ item, title }: { item: ConflictItem; title: string }) {
  switch (item.kind) {
    case "field":
      return <ConflictFieldRow field={item.field} itemTitle={title} />;
    case "appearance":
      return <AppearanceView item={item} />;
    case "edit-delete":
      return <EditDeleteView item={item} />;
    case "folder-delete":
      return <FolderDeleteView item={item} title={title} />;
    case "cycle":
      return <CycleView item={item} />;
    case "undecryptable":
      return <UndecryptableView item={item} />;
    case "epoch":
      return (
        <ItemBox title="Master password">
          <p className="text-xs text-ink-secondary">The master password was changed on two devices. Conduit asks you to choose when syncing.</p>
        </ItemBox>
      );
  }
}
