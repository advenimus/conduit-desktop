import { AppState } from '../services/state.js';

/** Normalize null port to default for the connection type */
export function defaultPort(port: number | null | undefined, connType: string): number {
  if (port != null) return port;
  switch (connType) {
    case 'ssh': return 22;
    case 'rdp': return 3389;
    case 'vnc': return 5900;
    default: return 0;
  }
}

/** Notify the renderer that a vault entry was created or modified (triggers UI refresh). */
export function notifyRendererEntryChanged(): void {
  const mainWindow = AppState.getInstance().getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vault:entry-changed');
  }
}

/**
 * Resolve an ID that may be a session ID (from active connections) to the
 * corresponding vault entry ID. Falls through to the original ID if no
 * matching MCP session is found — handles vault entry IDs transparently.
 */
export function resolveEntryId(id: string, state: AppState): string {
  const session = state.mcpConnections.get(id);
  if (!session) return id;

  // Session found — look up the vault entry by host/port/type match
  if (!state.getActiveVault().isUnlocked()) return id;
  const entries = state.getActiveVault().listEntries();
  const match = entries.find(
    (e) => e.host === session.host &&
      defaultPort(e.port, e.entry_type) === defaultPort(session.port, session.connection_type) &&
      e.entry_type === session.connection_type,
  );
  return match?.id ?? id;
}
