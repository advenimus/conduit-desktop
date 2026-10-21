import type { Session } from "../../../stores/sessionStore";
import type { EntryMeta, FolderData } from "../../../types/entry";
import { isLoginCredentialType } from "../../../types/credential";

// Shared empty arrays: zustand selectors must return a stable value, so `?? []` inline would loop.
const NO_ENTRIES: readonly EntryMeta[] = [];
const NO_FOLDERS: readonly FolderData[] = [];
const NO_SESSIONS: readonly Session[] = [];

/** Home treats a missing (null or undefined) list in a store as empty instead of crashing. */
export const selectEntries = (s: { entries?: readonly EntryMeta[] | null }): readonly EntryMeta[] => s.entries ?? NO_ENTRIES;
export const selectFolders = (s: { folders?: readonly FolderData[] | null }): readonly FolderData[] => s.folders ?? NO_FOLDERS;
export const selectSessions = (s: { sessions?: readonly Session[] | null }): readonly Session[] => s.sessions ?? NO_SESSIONS;
type CredentialList = { credentials?: readonly { credential_type?: string | null }[] | null };

export const selectCredentialCount = (s: CredentialList): number =>
  s.credentials?.filter((c) => isLoginCredentialType(c.credential_type)).length ?? 0;
export const selectGatewayCount = (s: CredentialList): number =>
  s.credentials?.filter((c) => !isLoginCredentialType(c.credential_type)).length ?? 0;
