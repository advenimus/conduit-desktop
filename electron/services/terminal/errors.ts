export type TerminalErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_BUSY'
  | 'SCREEN_BUSY'
  | 'UNSUPPORTED_SHELL'
  | 'INVALID_ARGUMENT';

/** Error with a stable code that the IPC layer passes through to MCP clients. */
export class TerminalError extends Error {
  constructor(
    readonly code: TerminalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TerminalError';
  }
}
