/**
 * Lets agents use secrets without seeing them (docs/KNOWLEDGE_BASE.md 2.2):
 * - before a typing request runs, refs in its text become real values;
 * - before a reading request answers, vault secret values in its output become refs.
 * Requests that could hand a value back (page scripts) may not contain refs at all.
 */

import { hasRefs } from '../services/secrets/secret-refs.js';
import { SecretRefError, substituteRefs, type ResolverVault } from '../services/secrets/secret-resolver.js';
import { SecretScrubber, type ScrubVault } from '../services/secrets/secret-scrubber.js';
import { errorResponse, type IpcResponse } from './ipc-response.js';

type GuardVault = ResolverVault & ScrubVault;

export interface GuardState {
  getActiveVault(): unknown;
}

interface GuardRequest {
  type: string;
  payload?: Record<string, unknown>;
}

/** Text fields that are typed into a session or connection. */
const TYPED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  TerminalExecute: ['command'],
  RdpType: ['text'],
  VncType: ['text'],
  WebSessionType: ['text'],
  WebSessionFillInput: ['value'],
  ConnectionOpen: ['username', 'password'],
};

/** Byte-array fields (terminal keystrokes) that may hold refs. */
const TYPED_BYTES: Readonly<Record<string, string>> = {
  TerminalSendKeys: 'data',
};

const NO_REFS: Readonly<Record<string, string>> = {
  WebSessionExecuteJs: 'code',
};

const SCRUBBED = new Set([
  'TerminalExecute',
  'TerminalSendKeys',
  'TerminalReadScreen',
  'TerminalReadBuffer',
  'CommandExecute',
  'WebSessionReadContent',
  'WebSessionGetElements',
  'WebSessionExecuteJs',
  'WebSessionGetTitle',
  'WebSessionGetUrl',
]);

const scrubber = new SecretScrubber();

export function clearSecretScrubber(): void {
  scrubber.clear();
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

function unlockedVault(state: GuardState): GuardVault | null {
  const vault = state.getActiveVault() as GuardVault | undefined;
  return vault && vault.isUnlocked() ? vault : null;
}

type Prepared = { ok: true; request: GuardRequest } | { ok: false; response: IpcResponse };

function substitutePayload(request: GuardRequest, state: GuardState): Prepared {
  const payload = request.payload ?? {};
  const fields = TYPED_FIELDS[request.type] ?? [];
  const bytesField = TYPED_BYTES[request.type];
  const textFields = fields.filter((f) => typeof payload[f] === 'string' && hasRefs(payload[f] as string));
  let decoded: string | null = null;
  if (bytesField && Array.isArray(payload[bytesField])) {
    try {
      const text = utf8.decode(Uint8Array.from(payload[bytesField] as number[]));
      if (hasRefs(text)) decoded = text;
    } catch {
      // Not valid UTF-8 (raw control bytes): refs can't be in it.
    }
  }
  if (textFields.length === 0 && decoded === null) return { ok: true, request };

  const vault = unlockedVault(state);
  if (!vault) {
    return { ok: false, response: errorResponse('VAULT_LOCKED', 'The vault is locked, so secret refs cannot be used. Ask the user to unlock Conduit.') };
  }

  try {
    const next: Record<string, unknown> = { ...payload };
    for (const f of textFields) next[f] = substituteRefs(vault, payload[f] as string).text;
    if (decoded !== null) next[bytesField] = Array.from(encoder.encode(substituteRefs(vault, decoded).text));
    return { ok: true, request: { ...request, payload: next } };
  } catch (e) {
    if (e instanceof SecretRefError) return { ok: false, response: errorResponse(e.code, e.message) };
    throw e;
  }
}

export async function guardSecrets(
  request: GuardRequest,
  state: GuardState,
  next: (request: GuardRequest) => Promise<IpcResponse>,
): Promise<IpcResponse> {
  const noRefField = NO_REFS[request.type];
  const noRefValue = noRefField ? request.payload?.[noRefField] : undefined;
  if (typeof noRefValue === 'string' && hasRefs(noRefValue)) {
    return errorResponse('SECRET_REF_ERROR', 'Secret refs cannot be used in page scripts. Use website_fill_input or website_type instead.');
  }

  const prepared = substitutePayload(request, state);
  if (!prepared.ok) return prepared.response;
  const response = await next(prepared.request);
  // Errors are scrubbed too: some quote the substituted input (a busy terminal names its running command).
  if (response.type === 'Success' && !SCRUBBED.has(request.type)) return response;
  const vault = unlockedVault(state);
  return vault ? { ...response, payload: scrubber.scrubDeep(vault, response.payload) } : response;
}
