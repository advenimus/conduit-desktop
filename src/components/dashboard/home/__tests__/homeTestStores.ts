import { vi } from "vitest";
import { useAuthStore } from "../../../../stores/authStore";
import { useEntryStore } from "../../../../stores/entryStore";
import { useSessionStore, type Session } from "../../../../stores/sessionStore";
import { useSyncStore } from "../../../../stores/syncStore";
import { useTeamStore } from "../../../../stores/teamStore";
import { useTierStore } from "../../../../stores/tierStore";
import { useVaultStore } from "../../../../stores/vaultStore";
import type { EntryMeta, FolderData } from "../../../../types/entry";
import { resetHomeFeeds } from "../homeFeeds";

export interface HomeStores {
  entries?: EntryMeta[];
  folders?: FolderData[];
  sessions?: Session[];
  vaultType?: "personal" | "team";
  canCreate?: boolean;
  /** Entry ids the plan locks. */
  locked?: string[];
}

/** Seeds every store the Home cards read with quiet defaults; returns the entry store actions as mocks. */
export function seedHomeStores(opts: HomeStores = {}) {
  const actions = {
    openEntry: vi.fn(async () => undefined),
    setSelectedEntry: vi.fn(),
    resolveCredential: vi.fn(async () => null as { password?: string | null } | null),
  };
  useEntryStore.setState({ entries: opts.entries ?? [], folders: opts.folders ?? [], ...actions } as never);
  useSessionStore.setState({ sessions: opts.sessions ?? [] });
  useVaultStore.setState({
    vaultType: opts.vaultType ?? "personal",
    credentials: [],
    cloudSyncState: null,
    localBackupState: null,
    teamSyncState: null,
  } as never);
  useTeamStore.setState({ canCreate: () => opts.canCreate ?? true } as never);
  useTierStore.setState({ maxConnections: -1, isTrialing: false, trialDaysRemaining: -1, lockedEntryIds: new Set(opts.locked ?? []) } as never);
  useAuthStore.setState({ authMode: "local", profile: null } as never);
  useSyncStore.setState({ state: null, displaced: null, sessionConflict: null } as never);
  resetHomeFeeds();
  return actions;
}
