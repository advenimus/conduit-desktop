/**
 * RDM XML file parser + type mapping.
 *
 * Reads a .rdm export file, extracts Connection elements, and maps them
 * to Conduit entry types for preview and import.
 */

import fs from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import { decryptSafePassword } from './rdm-crypto.js';
import type { RdmRawEntry, ImportPreviewEntry, PasswordListItem } from './types.js';

// ── XML parsing ─────────────────────────────────────────────────────

/**
 * Parse an .rdm file and extract raw connection entries.
 */
export function parseRdmFile(filePath: string): RdmRawEntry[] {
  const xml = fs.readFileSync(filePath, 'utf-8');

  const parser = new XMLParser({
    ignoreAttributes: false,
    // Preserve text content including newlines (Description field)
    trimValues: false,
    // Don't convert numbers/booleans — keep everything as strings
    parseTagValue: false,
    // Ensure single-element arrays stay as arrays
    isArray: (name) => name === 'Connection' || name === 'PasswordListItem',
  });

  const doc = parser.parse(xml);
  const connections = doc?.RDMExport?.Connections?.Connection;
  if (!connections || !Array.isArray(connections)) return [];

  return connections.map(parseConnection);
}

function str(val: unknown): string | null {
  if (val === undefined || val === null || val === '') return null;
  return String(val).trim() || null;
}

function parseConnection(conn: Record<string, unknown>): RdmRawEntry {
  const terminal = (conn.Terminal ?? {}) as Record<string, unknown>;
  const rdp = (conn.RDP ?? {}) as Record<string, unknown>;
  const web = (conn.Web ?? {}) as Record<string, unknown>;
  const groupDetails = (conn.GroupDetails ?? {}) as Record<string, unknown>;
  const credentials = (conn.Credentials ?? {}) as Record<string, unknown>;
  const vnc = (conn.VNC ?? {}) as Record<string, unknown>;
  const dataEntry = (conn.DataEntry ?? {}) as Record<string, unknown>;
  const document = (conn.Document ?? {}) as Record<string, unknown>;

  // Parse PasswordList items
  const passwordListRaw = (credentials.PasswordList as Record<string, unknown>)?.PasswordListItem;
  const passwordList: PasswordListItem[] = [];
  if (Array.isArray(passwordListRaw)) {
    for (const item of passwordListRaw) {
      const rec = item as Record<string, unknown>;
      passwordList.push({
        id: str(rec.ID) ?? '',
        name: str(rec.Name),
        user: str(rec.UserName),
        safePassword: str(rec.SafePassword),
        host: str(rec.Host),
        description: str(rec.Description),
      });
    }
  }

  return {
    id: str(conn.ID) ?? '',
    name: str(conn.Name) ?? 'Unnamed',
    connectionType: str(conn.ConnectionType) ?? '',
    group: str(conn.Group),
    description: str(conn.Description),

    // SSH
    terminalHost: str(terminal.Host),
    terminalUsername: str(terminal.Username),
    terminalSafePassword: str(terminal.SafePassword),

    // RDP
    url: str(conn.Url),
    rdpUsername: str(rdp.UserName),
    rdpSafePassword: str(rdp.SafePassword),

    // Web
    webBrowserUrl: str(conn.WebBrowserUrl),
    webUsername: str(web.UserName),
    webSafePassword: str(web.SafePassword),
    webIgnoreCertErrors: String(web.IgnoreCertificateErrors).toLowerCase() === 'true',
    webUsernameControlId: str(web.UserNameControlId),
    webPasswordControlId: str(web.PasswordControlId),
    webSubmitControlId: str(web.SubmitControlId),

    // Group
    groupDetailsUsername: str(groupDetails.UserName),
    groupDetailsSafePassword: str(groupDetails.SafePassword),

    // Credential entries
    credentialType: str(credentials.CredentialType),
    credentialUsername: str(credentials.UserName),
    credentialDomain: str(credentials.Domain),
    credentialSafePassword: str(credentials.SafePassword),
    credentialSafeApiKey: str(credentials.SafeAPIKey),
    credentialPasswordList: passwordList,

    // VNC (AppleRemoteDesktop)
    vncHost: str(vnc.Host),
    vncUsername: str(vnc.MsUser),
    vncSafePassword: str(vnc.MsSafePassword),

    // DataEntry (SecureNote)
    dataEntryType: str(dataEntry.SecureNoteType) ? 'SecureNote' : null,
    encryptedSecureNote: str(dataEntry.EncryptedSecureNote),

    // Document
    documentType: str(document.DocumentType),
    documentFilename: str(document.Filename),

    // CommandLine (SessionTool)
    commandLine: str(conn.CommandLine),

    // References
    credentialConnectionId: str(conn.CredentialConnectionID),
    parentId: str(conn.ParentID),
  };
}

// ── Type mapping ────────────────────────────────────────────────────

/**
 * Map raw RDM entries to Conduit preview entries.
 * Decryption uses the built-in per-type keys — no passphrase needed.
 */
export function mapToPreviewEntries(
  rawEntries: RdmRawEntry[],
): ImportPreviewEntry[] {
  const results: ImportPreviewEntry[] = [];

  for (const raw of rawEntries) {
    switch (raw.connectionType) {
      case 'Group':
        results.push(mapGroup(raw));
        break;
      case 'SSHShell':
        results.push(mapSsh(raw));
        break;
      case 'RDPConfigured':
        results.push(mapRdp(raw));
        break;
      case 'WebBrowser':
        results.push(mapWeb(raw));
        break;
      case 'Credential':
        results.push(...mapCredential(raw));
        break;
      case 'AppleRemoteDesktop':
        results.push(mapVnc(raw));
        break;
      case 'DataEntry':
        results.push(mapDataEntry(raw));
        break;
      case 'Document':
        results.push(mapDocument(raw));
        break;
      case 'SessionTool':
        results.push(mapCommand(raw));
        break;
      default:
        results.push({
          rdmId: raw.id,
          name: raw.name,
          conduitType: 'folder', // placeholder
          status: 'unsupported',
          statusMessage: `Unsupported connection type: ${raw.connectionType}`,
          folderPath: extractFolderPath(raw.group),
          host: null,
          port: null,
          username: null,
          password: null,
          domain: null,
          notes: raw.description,
          config: {},
          credentialConnectionId: null,
          isGroupCredential: false,
          isDuplicate: false,
          existingEntryId: null,
        });
        break;
    }
  }

  return results;
}

// ── Mappers ─────────────────────────────────────────────────────────

function mapGroup(raw: RdmRawEntry): ImportPreviewEntry {
  let username: string | null = null;
  let password: string | null = null;
  let hasCredentials = false;
  let decryptFailed = false;

  if (raw.groupDetailsUsername) {
    hasCredentials = true;
    username = raw.groupDetailsUsername;

    if (raw.groupDetailsSafePassword) {
      password = decryptSafePassword(raw.groupDetailsSafePassword, 'group');
      if (password === null) decryptFailed = true;
    }
  }

  const folderPath = extractFolderPath(raw.group);

  return {
    rdmId: raw.id,
    name: raw.name,
    conduitType: hasCredentials ? 'credential' : 'folder',
    status: decryptFailed ? 'decrypt-failed' : 'ready',
    statusMessage: decryptFailed ? 'Failed to decrypt group credential password' : null,
    folderPath,
    host: null,
    port: null,
    username,
    password,
    domain: null,
    notes: raw.description,
    config: {},
    credentialConnectionId: null,
    isGroupCredential: hasCredentials,
    isDuplicate: false,
    existingEntryId: null,
  };
}

function mapSsh(raw: RdmRawEntry): ImportPreviewEntry {
  let password: string | null = null;
  let decryptFailed = false;

  if (raw.terminalSafePassword) {
    password = decryptSafePassword(raw.terminalSafePassword, 'terminal');
    if (password === null) decryptFailed = true;
  }

  return {
    rdmId: raw.id,
    name: raw.name,
    conduitType: 'ssh',
    status: decryptFailed ? 'decrypt-failed' : 'ready',
    statusMessage: decryptFailed ? 'Failed to decrypt SSH password' : null,
    folderPath: extractFolderPath(raw.group),
    host: raw.terminalHost,
    port: 22,
    username: raw.terminalUsername,
    password,
    domain: null,
    notes: raw.description,
    config: {},
    credentialConnectionId: raw.credentialConnectionId,
    isGroupCredential: false,
    isDuplicate: false,
    existingEntryId: null,
  };
}

function mapRdp(raw: RdmRawEntry): ImportPreviewEntry {
  let password: string | null = null;
  let decryptFailed = false;
  let username = raw.rdpUsername;
  let domain: string | null = null;

  if (raw.rdpSafePassword) {
    password = decryptSafePassword(raw.rdpSafePassword, 'rdp');
    if (password === null) decryptFailed = true;
  }

  // Extract domain from username if present (DOMAIN\user format)
  if (username && username.includes('\\')) {
    const idx = username.indexOf('\\');
    domain = username.substring(0, idx);
    username = username.substring(idx + 1);
  }

  // Parse host and port from URL field (e.g. "server:3390")
  let host = raw.url;
  let port = 3389;
  if (host && host.includes(':')) {
    const lastColon = host.lastIndexOf(':');
    const portStr = host.substring(lastColon + 1);
    const parsed = parseInt(portStr, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 65535) {
      port = parsed;
      host = host.substring(0, lastColon);
    }
  }

  return {
    rdmId: raw.id,
    name: raw.name,
    conduitType: 'rdp',
    status: decryptFailed ? 'decrypt-failed' : 'ready',
    statusMessage: decryptFailed ? 'Failed to decrypt RDP password' : null,
    folderPath: extractFolderPath(raw.group),
    host,
    port,
    username,
    password,
    domain,
    notes: raw.description,
    config: {},
    credentialConnectionId: raw.credentialConnectionId,
    isGroupCredential: false,
    isDuplicate: false,
    existingEntryId: null,
  };
}

function mapWeb(raw: RdmRawEntry): ImportPreviewEntry {
  let password: string | null = null;
  let decryptFailed = false;

  if (raw.webSafePassword) {
    password = decryptSafePassword(raw.webSafePassword, 'web');
    if (password === null) decryptFailed = true;
  }

  // Build WebEntryConfig
  const config: Record<string, unknown> = {};
  if (raw.webIgnoreCertErrors) {
    config.ignoreCertErrors = true;
  }

  // Map autofill selectors if present
  if (raw.webUsernameControlId || raw.webPasswordControlId) {
    config.autofill = {
      enabled: true,
      usernameSelector: raw.webUsernameControlId
        ? `#${raw.webUsernameControlId}, [id="${raw.webUsernameControlId}"]`
        : undefined,
      passwordSelector: raw.webPasswordControlId
        ? `#${raw.webPasswordControlId}, [id="${raw.webPasswordControlId}"]`
        : undefined,
      submitSelector: raw.webSubmitControlId
        ? `#${raw.webSubmitControlId}, [id="${raw.webSubmitControlId}"]`
        : undefined,
    };
  }

  return {
    rdmId: raw.id,
    name: raw.name,
    conduitType: 'web',
    status: decryptFailed ? 'decrypt-failed' : 'ready',
    statusMessage: decryptFailed ? 'Failed to decrypt web password' : null,
    folderPath: extractFolderPath(raw.group),
    host: raw.webBrowserUrl,
    port: null,
    username: raw.webUsername,
    password,
    domain: null,
    notes: raw.description,
    config,
    credentialConnectionId: raw.credentialConnectionId,
    isGroupCredential: false,
    isDuplicate: false,
    existingEntryId: null,
  };
}

function mapCredential(raw: RdmRawEntry): ImportPreviewEntry[] {
  const folderPath = extractFolderPath(raw.group);

  // PasswordList credential — flatten into one entry per item
  if (raw.credentialType === 'PasswordList' && raw.credentialPasswordList.length > 0) {
    return raw.credentialPasswordList.map((item) => {
      let password: string | null = null;
      let decryptFailed = false;

      if (item.safePassword) {
        password = decryptSafePassword(item.safePassword, 'credential');
        if (password === null) decryptFailed = true;
      }

      const itemLabel = item.name || item.user || 'Unknown';
      return {
        rdmId: `${raw.id}::${item.id}`,
        name: `${raw.name} - ${itemLabel}`,
        conduitType: 'credential' as const,
        status: decryptFailed ? 'decrypt-failed' as const : 'ready' as const,
        statusMessage: decryptFailed ? 'Failed to decrypt credential password' : null,
        folderPath,
        host: item.host,
        port: null,
        username: item.user,
        password,
        domain: null,
        notes: item.description || raw.description,
        config: {},
        credentialConnectionId: null,
        isGroupCredential: false,
        isDuplicate: false,
        existingEntryId: null,
      };
    });
  }

  // ApiKey credential
  if (raw.credentialType === 'ApiKey') {
    let password: string | null = null;
    let decryptFailed = false;

    if (raw.credentialSafeApiKey) {
      password = decryptSafePassword(raw.credentialSafeApiKey, 'credentialApiKey');
      if (password === null) decryptFailed = true;
    }

    return [{
      rdmId: raw.id,
      name: raw.name,
      conduitType: 'credential',
      status: decryptFailed ? 'decrypt-failed' : 'ready',
      statusMessage: decryptFailed ? 'Failed to decrypt API key' : null,
      folderPath,
      host: null,
      port: null,
      username: null,
      password,
      domain: null,
      notes: raw.description,
      config: {},
      credentialConnectionId: null,
      isGroupCredential: false,
      isDuplicate: false,
      existingEntryId: null,
    }];
  }

  // Simple credential (just username + password)
  let password: string | null = null;
  let decryptFailed = false;

  if (raw.credentialSafePassword) {
    password = decryptSafePassword(raw.credentialSafePassword, 'credentialApiKey');
    if (password === null) decryptFailed = true;
  }

  // Username lives in Credentials.UserName, with fallback to GroupDetails.UserName
  const username = raw.credentialUsername ?? raw.groupDetailsUsername;

  // Extract domain from Credentials.Domain or from DOMAIN\user format
  let domain = raw.credentialDomain;
  let resolvedUsername = username;
  if (!domain && resolvedUsername && resolvedUsername.includes('\\')) {
    const idx = resolvedUsername.indexOf('\\');
    domain = resolvedUsername.substring(0, idx);
    resolvedUsername = resolvedUsername.substring(idx + 1);
  }

  return [{
    rdmId: raw.id,
    name: raw.name,
    conduitType: 'credential',
    status: decryptFailed ? 'decrypt-failed' : 'ready',
    statusMessage: decryptFailed ? 'Failed to decrypt credential password' : null,
    folderPath,
    host: null,
    port: null,
    username: resolvedUsername,
    password,
    domain,
    notes: raw.description,
    config: {},
    credentialConnectionId: null,
    isGroupCredential: false,
    isDuplicate: false,
    existingEntryId: null,
  }];
}

function mapVnc(raw: RdmRawEntry): ImportPreviewEntry {
  let password: string | null = null;
  let decryptFailed = false;

  if (raw.vncSafePassword) {
    password = decryptSafePassword(raw.vncSafePassword, 'vnc');
    if (password === null) decryptFailed = true;
  }

  return {
    rdmId: raw.id,
    name: raw.name,
    conduitType: 'vnc',
    status: decryptFailed ? 'decrypt-failed' : 'ready',
    statusMessage: decryptFailed ? 'Failed to decrypt VNC password' : null,
    folderPath: extractFolderPath(raw.group),
    host: raw.vncHost,
    port: 5900,
    username: raw.vncUsername,
    password,
    domain: null,
    notes: raw.description,
    config: {},
    credentialConnectionId: raw.credentialConnectionId,
    isGroupCredential: false,
    isDuplicate: false,
    existingEntryId: null,
  };
}

function mapDataEntry(raw: RdmRawEntry): ImportPreviewEntry {
  // Only SecureNote DataEntries have importable text content
  if (raw.dataEntryType !== 'SecureNote' || !raw.encryptedSecureNote) {
    return {
      rdmId: raw.id,
      name: raw.name,
      conduitType: 'document',
      status: 'unsupported',
      statusMessage: 'Unsupported data entry type (no text content)',
      folderPath: extractFolderPath(raw.group),
      host: null,
      port: null,
      username: null,
      password: null,
      domain: null,
      notes: raw.description,
      config: {},
      credentialConnectionId: null,
      isGroupCredential: false,
      isDuplicate: false,
      existingEntryId: null,
    };
  }

  const content = decryptSafePassword(raw.encryptedSecureNote, 'secureNote');
  const decryptFailed = content === null;

  return {
    rdmId: raw.id,
    name: raw.name,
    conduitType: 'document',
    status: decryptFailed ? 'decrypt-failed' : 'ready',
    statusMessage: decryptFailed ? 'Failed to decrypt secure note' : null,
    folderPath: extractFolderPath(raw.group),
    host: null,
    port: null,
    username: null,
    password: null,
    domain: null,
    notes: content ?? raw.description,
    config: {},
    credentialConnectionId: null,
    isGroupCredential: false,
    isDuplicate: false,
    existingEntryId: null,
  };
}

function mapDocument(raw: RdmRawEntry): ImportPreviewEntry {
  // If the document references a local file, try to read it
  if (raw.documentFilename) {
    let content: string | null = null;
    try {
      if (fs.existsSync(raw.documentFilename)) {
        content = fs.readFileSync(raw.documentFilename, 'utf-8');
      }
    } catch {
      // File not accessible — fall through
    }

    if (content) {
      return {
        rdmId: raw.id,
        name: raw.name,
        conduitType: 'document',
        status: 'ready',
        statusMessage: null,
        folderPath: extractFolderPath(raw.group),
        host: null,
        port: null,
        username: null,
        password: null,
        domain: null,
        notes: content,
        config: {},
        credentialConnectionId: null,
        isGroupCredential: false,
        isDuplicate: false,
        existingEntryId: null,
      };
    }
  }

  // No importable content (embedded data not in XML export, or missing file)
  return {
    rdmId: raw.id,
    name: raw.name,
    conduitType: 'document',
    status: 'unsupported',
    statusMessage: raw.documentFilename
      ? `File not found: ${raw.documentFilename}`
      : 'Document content not included in export',
    folderPath: extractFolderPath(raw.group),
    host: null,
    port: null,
    username: null,
    password: null,
    domain: null,
    notes: raw.description,
    config: {},
    credentialConnectionId: null,
    isGroupCredential: false,
    isDuplicate: false,
    existingEntryId: null,
  };
}

function mapCommand(raw: RdmRawEntry): ImportPreviewEntry {
  const commandLine = raw.commandLine ?? '';

  const config: Record<string, unknown> = {
    command: commandLine,
    args: '',
    workingDir: '',
    shell: '',
    timeout: 0,
    runAsMode: 'credential',
    guiApp: false,
  };

  return {
    rdmId: raw.id,
    name: raw.name,
    conduitType: 'command',
    status: commandLine ? 'ready' : 'unsupported',
    statusMessage: commandLine ? null : 'No command line configured',
    folderPath: extractFolderPath(raw.group),
    host: null,
    port: null,
    username: null,
    password: null,
    domain: null,
    notes: raw.description,
    config,
    credentialConnectionId: raw.credentialConnectionId,
    isGroupCredential: false,
    isDuplicate: false,
    existingEntryId: null,
  };
}

// ── Utilities ────────────────────────────────────────────────────────

/**
 * Extract the folder path from an RDM Group field.
 * RDM uses backslash-separated paths like "Personal\Servers\Production".
 * We strip the common "Personal\" prefix if present.
 */
function extractFolderPath(group: string | null): string | null {
  if (!group) return null;

  // RDM often prefixes with "Personal\" for local entries
  let cleaned = group;
  if (cleaned.startsWith('Personal\\')) {
    cleaned = cleaned.substring('Personal\\'.length);
  }

  return cleaned || null;
}
