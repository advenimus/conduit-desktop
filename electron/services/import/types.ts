/**
 * Types for the RDM import feature.
 */

import type { EntryType } from '../vault/vault.js';

/** Raw parsed fields from RDM XML Connection element. */
export interface RdmRawEntry {
  id: string;
  name: string;
  connectionType: string;
  group: string | null;
  description: string | null;

  // SSH (Terminal)
  terminalHost: string | null;
  terminalUsername: string | null;
  terminalSafePassword: string | null;

  // RDP
  url: string | null;
  rdpUsername: string | null;
  rdpSafePassword: string | null;

  // Web
  webBrowserUrl: string | null;
  webUsername: string | null;
  webSafePassword: string | null;
  webIgnoreCertErrors: boolean;
  webUsernameControlId: string | null;
  webPasswordControlId: string | null;
  webSubmitControlId: string | null;

  // Group
  groupDetailsUsername: string | null;
  groupDetailsSafePassword: string | null;

  // Credential entries
  credentialType: string | null;
  credentialUsername: string | null;
  credentialDomain: string | null;
  credentialSafePassword: string | null;
  credentialSafeApiKey: string | null;
  credentialPasswordList: PasswordListItem[];

  // VNC (AppleRemoteDesktop)
  vncHost: string | null;
  vncUsername: string | null;
  vncSafePassword: string | null;

  // DataEntry (SecureNote)
  dataEntryType: string | null;
  encryptedSecureNote: string | null;

  // Document
  documentType: string | null;
  documentFilename: string | null;

  // CommandLine (SessionTool)
  commandLine: string | null;

  // Credential reference
  credentialConnectionId: string | null;

  // Sub-entry parent
  parentId: string | null;
}

export interface PasswordListItem {
  id: string;
  name: string | null;
  user: string | null;
  safePassword: string | null;
  host: string | null;
  description: string | null;
}

export type ImportEntryStatus =
  | 'ready'
  | 'unsupported'
  | 'decrypt-failed'
  | 'tier-limit'
  | 'duplicate';

/** Mapped entry ready for preview / import. */
export interface ImportPreviewEntry {
  rdmId: string;
  name: string;
  conduitType: EntryType | 'folder';
  status: ImportEntryStatus;
  statusMessage: string | null;

  // Folder path (backslash-separated from RDM Group field)
  folderPath: string | null;

  // Mapped fields
  host: string | null;
  port: number | null;
  username: string | null;
  password: string | null;
  domain: string | null;
  notes: string | null;
  config: Record<string, unknown>;

  // Credential reference (RDM ID)
  credentialConnectionId: string | null;

  // Is this a group credential entry?
  isGroupCredential: boolean;

  // Duplicate detection
  isDuplicate: boolean;
  existingEntryId: string | null;
}

export type DuplicateStrategy = 'overwrite' | 'skip';

export type ImportEntryResultStatus = 'imported' | 'skipped' | 'error' | 'overwritten';

/** Per-entry result after import. */
export interface ImportEntryResult {
  name: string;
  conduitType: string;
  status: ImportEntryResultStatus;
  message: string;
  conduitId: string | null;
}

/** Summary of the full import operation. */
export interface ImportResult {
  totalParsed: number;
  imported: number;
  skipped: number;
  errors: number;
  entries: ImportEntryResult[];
}
