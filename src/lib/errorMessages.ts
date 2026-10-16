import type { SessionType } from "../stores/sessionStore";
import { parseRdpConnectError, type RdpConnectErrorInfo } from "./rdpConnectError";

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

/**
 * Errors a macOS Local Network block can surface as. FreeRDP runs as its own
 * process and only reports a generic transport failure, so that stays in.
 */
const POSSIBLE_LOCAL_NETWORK_BLOCK =
  /ConduitLocalNetworkBlocked|EHOSTUNREACH|EACCES|EPERM|No route to host|ERR_ADDRESS_UNREACHABLE|CONNECT_TRANSPORT_FAILED|transport (connection )?failed/i;

/** Whether a connection error is worth checking the macOS permission for. */
export function mayBeLocalNetworkBlock(raw: string): boolean {
  return POSSIBLE_LOCAL_NETWORK_BLOCK.test(raw);
}

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
    /authentication failure|ERRCONNECT_AUTHENTICATION_FAILED|logon failure|STATUS_LOGON_FAILURE|^Access denied\.?$|ERRCONNECT_ACCESS_DENIED/i,
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
    /transport (connection )?failed|transport layer failed|unable to connect|connection (failed|refused)|CONNECT_TRANSPORT_FAILED|CONNECT_FAILED/i,
    "Could not reach the server. Check that the host and port are correct, the machine is online, and Remote Desktop is enabled. A firewall or VPN may be blocking it.",
  ],
];

/** Gateway setup errors (GatewayConfigError) are already worded for people; Electron may prefix the class name. */
const GATEWAY_CONFIG_ERROR = /^(?:GatewayConfigError:\s*)?(The gateway (?:this entry uses|"[^"]*"|setting is not valid)[\s\S]*)$/;

const GATEWAY_LOGIN_MESSAGE =
  "The gateway did not accept the login. Check the login in the gateway's settings, or in this entry if the gateway uses the entry's login.";

/** E_PROXY_* faults (rpc_fault.c) only come from a gateway, so they apply to every RDP session. */
const gatewayCodePatterns: [RegExp, string][] = [
  [
    /E_PROXY_(COOKIE_AUTHENTICATION_ACCESS_DENIED|UNSUPPORTED_AUTHENTICATION_METHOD|REAUTH_AUTHN_FAILED)/,
    GATEWAY_LOGIN_MESSAGE,
  ],
  [
    /E_PROXY_(RAP|NAP|QUARANTINE)_ACCESSDENIED|E_PROXY_REAUTH_(RAP|NAP)_FAILED/,
    "The gateway refused the connection. Its policy does not allow this account to reach this computer. Ask the gateway admin to allow it, or check the computer's name.",
  ],
  [
    /E_PROXY_TS_CONNECTFAILED/,
    "The gateway could not reach this computer. Check the host name and port. The gateway must be able to reach it on its own network.",
  ],
  [
    /E_PROXY_NOCERTAVAILABLE/,
    "The gateway has no certificate set up. Ask the gateway admin to check its certificate.",
  ],
  [
    /E_PROXY_\w+/,
    "The gateway reported an error. Try again, and if it keeps happening, ask the gateway admin to check its logs.",
  ],
];

const GATEWAY_DNS_MESSAGE =
  "The gateway's address could not be found. Check the gateway server name, and that DNS or your VPN can reach it.";
const GATEWAY_TLS_MESSAGE =
  "The secure connection to the gateway failed. Check the gateway server name and port, and that the gateway's certificate is valid.";
const GATEWAY_UNREACHABLE_MESSAGE =
  "Could not reach the gateway. Check the gateway server name and port, and that your network or VPN can reach it.";

// FreeRDP reports the gateway's HTTP 401 as ACCESS_DENIED (rdg.c, rpc_client.c), the same code NLA uses at the computer.
const GATEWAY_PHASE_CODES = new Map<number, string>([
  [0x00020016, GATEWAY_LOGIN_MESSAGE],
  [0x00020009, GATEWAY_LOGIN_MESSAGE],
  [0x00020004, GATEWAY_DNS_MESSAGE],
  [0x00020005, GATEWAY_DNS_MESSAGE],
  [0x00020008, GATEWAY_TLS_MESSAGE],
  [0x00020006, GATEWAY_UNREACHABLE_MESSAGE],
  [0x0002000d, GATEWAY_UNREACHABLE_MESSAGE],
]);

/** Text only a gateway produces (HTTP and RPC), whatever hop the helper reported. */
const gatewayOnlyPatterns: [RegExp, string][] = [
  [/\b401\b|Unauthorized|RPC_S_ACCESS_DENIED/i, GATEWAY_LOGIN_MESSAGE],
];

/** Used only when the helper reported that the connect failed before the gateway tunnel was up. */
const gatewayPhasePatterns: [RegExp, string][] = [
  [/^Access denied\.?$|ERRCONNECT_ACCESS_DENIED/i, GATEWAY_LOGIN_MESSAGE],
  [/\bDNS\b|name (was )?not found|could not be resolved|DNS_NAME_NOT_FOUND/i, GATEWAY_DNS_MESSAGE],
  [/TLS|certificate|SSL handshake|ERRCONNECT_TLS/i, GATEWAY_TLS_MESSAGE],
  [
    /transport (connection )?failed|transport layer failed|unable to connect|connection (failed|refused)|CONNECT_TRANSPORT_FAILED|CONNECT_FAILED/i,
    GATEWAY_UNREACHABLE_MESSAGE,
  ],
];

function rdpTablesFor(info: RdpConnectErrorInfo, gateway: boolean): [RegExp, string][][] {
  if (!gateway) return [gatewayCodePatterns, rdpPatterns];
  if (info.phase === "gateway") return [gatewayCodePatterns, gatewayOnlyPatterns, gatewayPhasePatterns, rdpPatterns];
  if (info.phase === "target") return [gatewayCodePatterns, rdpPatterns];
  return [gatewayCodePatterns, gatewayOnlyPatterns, rdpPatterns];
}

/** The error text without the code and hop marker the main process adds to RDP connect errors. */
export function connectionErrorText(raw: string): string {
  return parseRdpConnectError(raw).message;
}

export interface FriendlyErrorOptions {
  /** The RDP session connects through an RD Gateway. */
  gateway?: boolean;
}

/**
 * Maps raw technical error messages to user-friendly descriptions.
 * RDP sessions consult the RDP-specific table first so the guidance is
 * tailored to Remote Desktop. Falls through to the raw message if no
 * pattern matches.
 */
export function friendlyConnectionError(raw: string, type?: SessionType, options?: FriendlyErrorOptions): string {
  if (LOCAL_NETWORK_BLOCKED.test(raw)) return LOCAL_NETWORK_MESSAGE;

  const info = parseRdpConnectError(raw);
  const text = info.message;
  const gatewayConfig = GATEWAY_CONFIG_ERROR.exec(text);
  if (gatewayConfig) return gatewayConfig[1];

  const gateway = type === "rdp" && options?.gateway === true;
  const byCode = gateway && info.phase === "gateway" && info.code !== undefined ? GATEWAY_PHASE_CODES.get(info.code) : undefined;
  if (byCode && !gatewayCodePatterns.some(([re]) => re.test(text))) return byCode;

  const tables = type === "rdp" ? [...rdpTablesFor(info, gateway), patterns] : [patterns];
  for (const table of tables) {
    for (const [re, friendly] of table) {
      if (re.test(text)) return friendly;
    }
  }
  return text;
}
