// The server's ERRINFO codes (MS-RDPBCGR 2.2.5.1.1) that mean someone ended the session on purpose, not that it failed.
const ERRINFO_RPC_INITIATED_DISCONNECT = 0x1;
const ERRINFO_RPC_INITIATED_LOGOFF = 0x2;
const ERRINFO_RPC_INITIATED_DISCONNECT_BYUSER = 0xb;
const ERRINFO_LOGOFF_BY_USER = 0xc;

const REMOTE_END_CODES: ReadonlySet<number> = new Set([
  ERRINFO_RPC_INITIATED_DISCONNECT,
  ERRINFO_RPC_INITIATED_LOGOFF,
  ERRINFO_RPC_INITIATED_DISCONNECT_BYUSER,
  ERRINFO_LOGOFF_BY_USER,
]);

/** True for a sign-out, or a disconnect chosen on the remote computer, so the tab can close instead of showing an error. */
export function isRemoteSessionEnd(errorInfo: number | null | undefined): boolean {
  return typeof errorInfo === 'number' && REMOTE_END_CODES.has(errorInfo);
}
