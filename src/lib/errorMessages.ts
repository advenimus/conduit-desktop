import type { SessionType } from "../stores/sessionStore";

/**
 * Marker the main process appends when it has confirmed macOS blocked the
 * connection (see electron/services/local-network.ts). Checked ahead of every
 * table because the underlying errno is EHOSTUNREACH, which the generic
 * patterns would otherwise explain as an unreachable host.
 */
const LOCAL_NETWORK_BLOCKED = /ConduitLocalNetworkBlocked/;

export function localNetworkSettingsAppName(): string {
  return import.meta.env.DEV ? "Conduit Dev" : "Conduit";
}

export function localNetworkPermissionMessage(appName: string): string {
  return `macOS is blocking ${appName}'s access to your local network. Open System Settings › Privacy & Security › Local Network and turn on ${appName}.`;
}

const LOCAL_NETWORK_MESSAGE = localNetworkPermissionMessage(localNetworkSettingsAppName());

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
 * RDP-specific mappings for the terse error strings the FreeRDP helper reports
 * (from freerdp_get_last_error_string). These are checked before the generic
 * patterns when the session is RDP, so the guidance can be tailored to Windows
 * Remote Desktop (NLA, domains, certificates). Each message stays actionable
 * and the raw text is still shown beneath it by the error screen.
 */
const rdpPatterns: [RegExp, string][] = [
  // Account password expired (must be changed before sign in).
  [
    /password (is )?(expired|certainly expired)|password.*must.*change|PASSWORD_EXPIRED/i,
    "The account password has expired. Change it on the server, then reconnect.",
  ],
  // Account is not permitted to sign in via RDP.
  [
    /insufficient privileg|account restriction|access is denied|logon type/i,
    "This account is not allowed to sign in over Remote Desktop. Add it to the server's Remote Desktop Users group, or use an account that has access.",
  ],
  // CredSSP / NLA credential rejection (0x00020009). This is the common
  // "works on my workgroup box, fails on the domain server" case: when a
  // domain blocks NTLM and the client connects by IP (no Kerberos SPN), the
  // server rejects the sign in.
  [
    /authentication failure|ERRCONNECT_AUTHENTICATION_FAILED|logon failure|STATUS_LOGON_FAILURE/i,
    "The server rejected the sign in. Check the username and password. If this is a domain server, set the Domain field and connect using the server's full hostname instead of an IP address. Some domains block NTLM and require Kerberos, which only works when you connect by hostname.",
  ],
  // Security negotiation failed (server likely requires NLA, or no common protocol).
  [
    /security negotiation|SECURITY_NEGO|negotiation has failed/i,
    "The server refused the security negotiation. It may require Network Level Authentication (NLA). Try enabling NLA in this connection's security settings.",
  ],
  // TLS handshake / certificate problems.
  [
    /TLS|certificate|SSL handshake|ERRCONNECT_TLS/i,
    "The secure (TLS) connection to the server failed. The certificate may be untrusted or the server's security settings may be incompatible. You can enable 'Skip certificate verification' for this connection if you trust the host.",
  ],
  // Name resolution.
  [
    /\bDNS\b|name (was )?not found|could not be resolved|DNS_NAME_NOT_FOUND/i,
    "The server's hostname could not be resolved. Check the address, and that DNS or your VPN can reach it.",
  ],
  // TCP / transport could not be established.
  [
    /transport (connection )?failed|unable to connect|connection (failed|refused)|CONNECT_TRANSPORT_FAILED|CONNECT_FAILED/i,
    "Could not reach the server. Check that the host and port are correct, the machine is online, and Remote Desktop is enabled. A firewall or VPN may be blocking it.",
  ],
];

/**
 * Maps raw technical error messages to user-friendly descriptions.
 * RDP sessions consult the RDP-specific table first so the guidance is
 * tailored to Remote Desktop. Falls through to the raw message if no
 * pattern matches.
 */
export function friendlyConnectionError(raw: string, type?: SessionType): string {
  if (LOCAL_NETWORK_BLOCKED.test(raw)) return LOCAL_NETWORK_MESSAGE;

  const tables = type === "rdp" ? [rdpPatterns, patterns] : [patterns];
  for (const table of tables) {
    for (const [re, friendly] of table) {
      if (re.test(raw)) return friendly;
    }
  }
  return raw;
}
