/**
 * The JSON body of a failed tool call. Errors from the Conduit app keep their code and reason
 * (for example VAULT_LOCKED with reason open_elsewhere) so agents can tell why a call failed.
 */

import { IpcRequestError } from './ipc-client.js';

export interface ToolErrorBody {
  readonly error: string;
  readonly code?: string;
  readonly reason?: string;
}

export function toolErrorBody(err: unknown): ToolErrorBody {
  const error = err instanceof Error ? err.message : String(err);
  if (!(err instanceof IpcRequestError)) return { error };
  if (err.reason === undefined) return { error, code: err.code };
  return { error, code: err.code, reason: err.reason };
}
