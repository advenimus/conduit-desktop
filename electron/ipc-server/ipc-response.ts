/** Must match the protocol in mcp/src/ipc-client.ts exactly. */
export interface IpcResponse {
  type: 'Success' | 'Error';
  payload: unknown;
}

export function successResponse(payload: unknown): IpcResponse {
  return { type: 'Success', payload };
}

export function errorResponse(code: string, message: string): IpcResponse {
  return { type: 'Error', payload: { code, message } };
}
