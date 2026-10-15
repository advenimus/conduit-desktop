import { AppwriteException, type Client, ExecutionMethod, Functions, ID, Storage } from 'node-appwrite';
import { InputFile } from 'node-appwrite/file';
import type { DirectFiles, Transport } from './index.ts';

export const API_FUNCTION_ID = 'api';

/**
 * Sends requests as synchronous executions of the api function. With a session client the function
 * sees the signed-in user; with an API key client plus serviceSecret it runs as the trusted service.
 */
export function functionTransport(client: Client, opts: { functionId?: string; serviceSecret?: string } = {}): Transport {
  const fns = new Functions(client);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.serviceSecret) headers['x-conduit-service'] = opts.serviceSecret;
  return async (body, signal) => {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const run = fns
      .createExecution({ functionId: opts.functionId ?? API_FUNCTION_ID, body, async: false, method: ExecutionMethod.POST, xpath: '/', headers })
      .then(
        (ex) => ({ status: ex.responseStatusCode, body: ex.responseBody }),
        (e: unknown) => {
          // Appwrite refused the execution itself (revoked session, rate limit, server error): keep the
          // status so callers can tell "signed out" from "offline". 401 is the old 28000.
          if (!(e instanceof AppwriteException) || !e.code) throw e;
          const code = e.code === 401 ? '28000' : e.code >= 500 ? 'XX000' : String(e.code);
          return { status: e.code, body: JSON.stringify({ data: null, error: { code, message: e.message, details: e.type ?? null, hint: null } }) };
        },
      );
    if (!signal) return run;
    return Promise.race([
      run,
      new Promise<never>((_, reject) =>
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }),
      ),
    ]);
  };
}

/** DirectFiles over a session client (or a getter for the current one). */
export function directFiles(client: Client | (() => Client | null)): DirectFiles {
  const current = (): Client => {
    const c = typeof client === 'function' ? client() : client;
    if (!c) throw Object.assign(new Error('not authenticated'), { code: 401 });
    return c;
  };
  return {
    async stage(bytes, _contentType) {
      const file = await new Storage(current()).createFile({ bucketId: 'uploads', fileId: ID.unique(), file: InputFile.fromBuffer(bytes, 'upload.bin') });
      return file.$id;
    },
    // Plain HTTP, because the SDK parses a JSON file into an object instead of returning its bytes.
    async fetch(bucket, fileId) {
      const { endpoint, project, session } = current().config as { endpoint: string; project: string; session: string };
      const res = await fetch(`${endpoint}/storage/buckets/${encodeURIComponent(bucket)}/files/${encodeURIComponent(fileId)}/download`, {
        headers: { 'X-Appwrite-Project': project, 'X-Appwrite-Session': session },
      });
      if (!res.ok) throw Object.assign(new Error(`file download failed (HTTP ${res.status})`), { code: res.status });
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
