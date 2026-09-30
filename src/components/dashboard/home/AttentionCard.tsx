import { useEffect, useMemo, useState } from "react";
import { PASSWORD_AGE_LIST_LIMIT, type AttentionAction, type AttentionItem, type HomeSettings, type PasswordAgeItem } from "../../../types/dashboard";
import type { EntryMeta } from "../../../types/entry";
import { dashboardApi } from "../../../lib/dashboardApi";
import { invoke } from "../../../lib/electron";
import { AlertTriangleIcon } from "../../../lib/icons";
import { openDashboardForEntry } from "../../../lib/openDashboard";
import { useAuthStore } from "../../../stores/authStore";
import { useEntryStore } from "../../../stores/entryStore";
import { useSyncStore } from "../../../stores/syncStore";
import { useTierStore } from "../../../stores/tierStore";
import { useVaultStore } from "../../../stores/vaultStore";
import { Button, Card, cx, ListRow, SectionHeader } from "../../ui";
import { buildAttentionItems, formatAge } from "./attention";
import { countConnections, EntryIcon } from "./entryDisplay";
import { useDebounced } from "./useDebounced";
import { selectEntries } from "./storeSelectors";

const ENTRIES_CHANGE_DEBOUNCE_MS = 1000;

/** Password ages on mount and 1 s after the entries change; null when turned off or on error. */
function usePasswordAges(enabled: boolean, entries: readonly EntryMeta[]): readonly PasswordAgeItem[] | null {
  const debouncedEntries = useDebounced(entries, ENTRIES_CHANGE_DEBOUNCE_MS);
  const [ages, setAges] = useState<readonly PasswordAgeItem[] | null>(null);
  useEffect(() => {
    if (!enabled) {
      setAges(null);
      return;
    }
    let alive = true;
    dashboardApi
      .passwordAges()
      .then((rows) => {
        if (alive) setAges(rows);
      })
      .catch((err) => {
        console.warn("[home] password_age_list failed:", err);
        if (alive) setAges(null);
      });
    return () => {
      alive = false;
    };
  }, [enabled, debouncedEntries]);
  return ages;
}

function runAction(action: AttentionAction): void {
  switch (action) {
    case "review-sync":
      useSyncStore.getState().openView({ kind: "review", row: null });
      return;
    case "open-sync-settings":
      document.dispatchEvent(new CustomEvent("conduit:settings", { detail: { tab: "sync" } }));
      return;
    case "open-backup-settings":
      document.dispatchEvent(new CustomEvent("conduit:settings", { detail: { tab: "backup" } }));
      return;
    case "see-plans":
      invoke("auth_open_pricing").catch((err) => console.warn("[home] auth_open_pricing failed:", err));
      return;
    case "show-passwords":
      return;
  }
}

interface PasswordListProps {
  entryIds: readonly string[];
  entries: readonly EntryMeta[];
  setAt: ReadonlyMap<string, string>;
}

function PasswordList({ entryIds, entries, setAt }: PasswordListProps) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const listed = entryIds.flatMap((id) => {
    const entry = byId.get(id);
    return entry ? [entry] : [];
  });
  const now = Date.now();
  const more = listed.length - PASSWORD_AGE_LIST_LIMIT;
  return (
    <div className="mt-2 ml-4 space-y-px">
      {listed.slice(0, PASSWORD_AGE_LIST_LIMIT).map((entry) => (
        <ListRow
          key={entry.id}
          leading={<EntryIcon entry={entry} />}
          meta={setAt.has(entry.id) ? `${formatAge(setAt.get(entry.id)!, now)} old` : undefined}
          onClick={() => openDashboardForEntry(entry.id)}
        >
          {entry.name}
        </ListRow>
      ))}
      {more > 0 && <p className="px-2 text-meta text-ink-faint">And {more} more</p>}
    </div>
  );
}

function AttentionRow({ item, entries, setAt }: { item: AttentionItem } & Omit<PasswordListProps, "entryIds">) {
  const [showList, setShowList] = useState(false);
  const isPasswords = item.action === "show-passwords";
  const label = isPasswords && showList ? "Hide entries" : item.actionLabel;
  return (
    <div data-attention={item.kind}>
      <div className="flex items-start gap-2">
        <AlertTriangleIcon size={16} className={cx("mt-px shrink-0", item.tone === "danger" ? "text-danger" : "text-warning")} />
        <div className="min-w-0 flex-1">
          <p className="text-label text-ink">{item.title}</p>
          {item.detail && <p className="mt-0.5 text-meta text-ink-muted">{item.detail}</p>}
        </div>
        {item.action && (
          <Button size="sm" className="shrink-0" aria-expanded={isPasswords ? showList : undefined} onClick={() => (isPasswords ? setShowList((v) => !v) : runAction(item.action!))}>
            {label}
          </Button>
        )}
      </div>
      {isPasswords && showList && item.entryIds && <PasswordList entryIds={item.entryIds} entries={entries} setAt={setAt} />}
    </div>
  );
}

/** Needs attention (docs/DASHBOARD.md 4.6); hidden when nothing needs attention. */
export default function AttentionCard({ settings }: { settings: HomeSettings }) {
  const entries = useEntryStore(selectEntries);
  const syncState = useSyncStore((s) => s.state);
  const displaced = useSyncStore((s) => s.displaced);
  const sessionConflict = useSyncStore((s) => s.sessionConflict);
  const cloudSyncState = useVaultStore((s) => s.cloudSyncState);
  const localBackupState = useVaultStore((s) => s.localBackupState);
  const teamSyncState = useVaultStore((s) => s.teamSyncState);
  const authMode = useAuthStore((s) => s.authMode);
  const maxConnections = useTierStore((s) => s.maxConnections);
  const isTrialing = useTierStore((s) => s.isTrialing);
  const trialDaysRemaining = useTierStore((s) => s.trialDaysRemaining);
  const passwordAges = usePasswordAges(settings.passwordAgeDays !== null, entries);

  const items = useMemo(
    () =>
      buildAttentionItems({
        now: Date.now(),
        syncState,
        displaced,
        sessionConflict,
        teamSyncState,
        localBackupState,
        cloudSyncState,
        authMode,
        passwordAges,
        entryIds: new Set(entries.map((e) => e.id)),
        settings,
        maxConnections,
        connectionCount: countConnections(entries),
        isTrialing,
        trialDaysRemaining,
      }),
    [syncState, displaced, sessionConflict, teamSyncState, localBackupState, cloudSyncState, authMode, passwordAges, entries, settings, maxConnections, isTrialing, trialDaysRemaining],
  );
  const setAt = useMemo(() => new Map((passwordAges ?? []).map((p) => [p.entryId, p.setAt])), [passwordAges]);

  if (items.length === 0) return null;
  return (
    <Card>
      <SectionHeader title="Needs attention" />
      <div className="space-y-3">
        {items.map((item) => (
          <AttentionRow key={item.kind} item={item} entries={entries} setAt={setAt} />
        ))}
      </div>
    </Card>
  );
}
