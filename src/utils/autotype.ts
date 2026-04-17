/**
 * Auto-type utility for typing credentials into the active session.
 *
 * Dispatches text to the correct IPC handler based on session type
 * (RDP, SSH, VNC, Web, local shell).
 */

import { useSessionStore, type Session, type SessionType } from "../stores/sessionStore";
import { invoke } from "../lib/electron";

const TYPEABLE_SESSION_TYPES: ReadonlySet<SessionType> = new Set([
  "rdp",
  "ssh",
  "local_shell",
  "vnc",
  "web",
]);

/** Returns the active session if it is connected and supports text input, otherwise null. */
export function getTypeableActiveSession(): Session | null {
  const { activeSessionId, sessions } = useSessionStore.getState();
  if (!activeSessionId) return null;

  const session = sessions.find((s) => s.id === activeSessionId);
  if (!session) return null;
  if (session.status !== "connected") return null;
  if (!TYPEABLE_SESSION_TYPES.has(session.type)) return null;

  return session;
}

const AUTOTYPE_DELAY_MS = 2000;
const GLOBAL_AUTOTYPE_DELAY_MS = 3000;
const INTER_STEP_DELAY_MS = 100;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Type text into a specific session (no delay). */
async function typeTextInSession(session: Session, text: string): Promise<void> {
  const sessionId = session.id;

  switch (session.type) {
    case "rdp":
      await invoke("rdp_type", { sessionId, text });
      break;
    case "ssh":
    case "local_shell":
      await invoke("terminal_write", {
        sessionId,
        data: [...new TextEncoder().encode(text)],
      });
      break;
    case "vnc":
      await invoke("vnc_type", { sessionId, text });
      break;
    case "web":
      await invoke("web_session_type", { sessionId, text });
      break;
    default:
      throw new Error(`Unsupported session type: ${session.type}`);
  }
}

/** Send a Tab keystroke to a specific session. */
async function sendTabToSession(session: Session): Promise<void> {
  const sessionId = session.id;

  switch (session.type) {
    case "rdp":
      await invoke("rdp_send_key", { sessionId, key: "Tab" });
      break;
    case "ssh":
    case "local_shell":
      await invoke("terminal_write", {
        sessionId,
        data: [0x09],
      });
      break;
    case "vnc":
      await invoke("vnc_send_key", { sessionId, key: "Tab" });
      break;
    case "web":
      await invoke("web_session_send_key", { sessionId, key: "Tab" });
      break;
    default:
      throw new Error(`Unsupported session type: ${session.type}`);
  }
}

/**
 * Type text into the currently active session after a 2-second delay,
 * giving the user time to click into the target field.
 * Throws if no typeable session is active.
 */
export async function typeIntoActiveSession(text: string): Promise<void> {
  const session = getTypeableActiveSession();
  if (!session) {
    throw new Error("No active typeable session");
  }

  await delay(AUTOTYPE_DELAY_MS);

  // Re-resolve the session after the delay in case it changed
  const currentSession = getTypeableActiveSession();
  if (!currentSession) {
    throw new Error("Session closed during auto-type delay");
  }

  await typeTextInSession(currentSession, text);
}

/**
 * Type username, send Tab, then type password into the active session
 * after a 2-second delay. Throws if no typeable session is active.
 */
export async function typeUsernameTabPassword(username: string, password: string): Promise<void> {
  const session = getTypeableActiveSession();
  if (!session) {
    throw new Error("No active typeable session");
  }

  await delay(AUTOTYPE_DELAY_MS);

  const currentSession = getTypeableActiveSession();
  if (!currentSession) {
    throw new Error("Session closed during auto-type delay");
  }

  await typeTextInSession(currentSession, username);
  await delay(INTER_STEP_DELAY_MS);
  await sendTabToSession(currentSession);
  await delay(INTER_STEP_DELAY_MS);
  await typeTextInSession(currentSession, password);
}

// ── Global auto-type (types into any external OS window) ─────────────────

/**
 * Type text into the currently focused OS window after a 3-second delay.
 * Uses OS-level keystroke simulation (AppleScript on macOS, SendKeys on Windows).
 */
export async function globalTypeText(text: string): Promise<void> {
  await delay(GLOBAL_AUTOTYPE_DELAY_MS);
  await invoke("autotype:global_type", { text });
}

/**
 * Type username, send Tab, then type password into the focused OS window
 * after a 3-second delay.
 */
export async function globalTypeUsernameTabPassword(username: string, password: string): Promise<void> {
  await delay(GLOBAL_AUTOTYPE_DELAY_MS);
  await invoke("autotype:global_type_sequence", { username, password });
}
