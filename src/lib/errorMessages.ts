import type { SessionType } from "../stores/sessionStore";

const patterns: [RegExp, string][] = [
  [/All configured authentication methods failed/i, "Authentication failed — check your username, password, or SSH key"],
  [/getaddrinfo ENOTFOUND/i, "Host not found — check the hostname or IP address"],
  [/connect ECONNREFUSED/i, "Connection refused — the service may not be running on this port"],
  [/connect ETIMEDOUT|Timed out/i, "Connection timed out — check hostname and network connectivity"],
  [/EHOSTUNREACH/i, "Host unreachable — check network connectivity"],
  [/VNC authentication failed/i, "VNC authentication failed — check your password"],
  [/ECONNRESET/i, "Connection was reset by the remote host"],
  [/EPIPE|Broken pipe/i, "Connection lost — the remote host closed the connection"],
  [/ERR_ADDRESS_UNREACHABLE/i, "Host unreachable — check the IP address and network connectivity"],
  [/ERR_CONNECTION_TIMED_OUT/i, "Connection timed out — check hostname and network connectivity"],
  [/ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED/i, "Could not reach the host — check the URL and network connectivity"],
  [/ERR_INTERNET_DISCONNECTED/i, "No internet connection — check your network"],
];

/**
 * Maps raw technical error messages to user-friendly descriptions.
 * Falls through to the raw message if no pattern matches.
 */
export function friendlyConnectionError(raw: string, _type?: SessionType): string {
  for (const [re, friendly] of patterns) {
    if (re.test(raw)) return friendly;
  }
  return raw;
}
