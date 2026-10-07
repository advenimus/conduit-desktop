/** MCP requests that create and change secrets without the agent ever holding the value. */

import type { AppState } from '../../services/state.js';
import { parseRefs } from '../../services/secrets/secret-refs.js';
import {
  commitRotation,
  createEmbeddedSecret,
  discardRotation,
  stageRotation,
  type SecretVault,
} from '../../services/secrets/embedded-secrets.js';
import { generateSecret, type GenerateOptions } from '../../services/secrets/secret-generate.js';
import { agentDisplayName } from '../agent-names.js';
import { notifyRendererEntryChanged, resolveEntryId } from '../entry-helpers.js';
import { errorResponse, successResponse, type IpcResponse } from '../ipc-response.js';
import type { AgentIdentity } from '../session-claims.js';
import { lockedResponse, vaultFailure } from '../vault-guard.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPTURE_SCREEN_LINES = 500;
const MAX_CAPTURE_LENGTH = 4096;

export const SECRET_REQUEST_TYPES = new Set(['SecretCreate', 'SecretRotate', 'SecretCommit', 'SecretDiscard', 'SecretCapture']);

class BadRequest extends Error {}

/** Accepts a bare id or any ref that points at one. */
export function secretIdOf(value: unknown): string {
  if (typeof value !== 'string') throw new BadRequest('secret is required (an id or a {{secret:...}} ref)');
  const trimmed = value.trim();
  if (UUID_RE.test(trimmed)) return trimmed.toLowerCase();
  const [ref] = parseRefs(trimmed);
  if (!ref) throw new BadRequest('secret must be an id or a {{secret:...}} / {{cred:...}} ref');
  return ref.id;
}

function valueFrom(payload: Record<string, unknown>): string {
  if (payload.generate && typeof payload.generate === 'object') return generateSecret(payload.generate as GenerateOptions);
  if (payload.generate === true) return generateSecret();
  if (typeof payload.value === 'string' && payload.value.length > 0) return payload.value;
  throw new BadRequest('Give generate (preferred, so the value never passes through you) or value.');
}

function ownerIdOf(payload: Record<string, unknown>, state: AppState): string {
  if (typeof payload.owner_id !== 'string' || !payload.owner_id) throw new BadRequest('owner_id is required');
  const id = resolveEntryId(payload.owner_id, state);
  state.getActiveVault().getEntryMeta(id);
  return id;
}

async function captureValue(payload: Record<string, unknown>, state: AppState): Promise<string> {
  const sessionId = typeof payload.connection_id === 'string' ? payload.connection_id : '';
  if (typeof payload.pattern === 'string' && payload.pattern) {
    let re: RegExp;
    try {
      re = new RegExp(payload.pattern, 'm');
    } catch (e) {
      throw new BadRequest(`pattern is not a valid regular expression: ${(e as Error).message}`);
    }
    const screen = await state.terminalManager.readScreen(sessionId, CAPTURE_SCREEN_LINES);
    const match = re.exec(screen.lines.join('\n'));
    if (!match) throw new BadRequest('pattern matched nothing on the terminal screen.');
    return (match[1] ?? match[0]).trim();
  }
  if (typeof payload.selector === 'string' && payload.selector) {
    const code = `(() => { const el = document.querySelector(${JSON.stringify(payload.selector)}); ` +
      `if (!el) return null; return 'value' in el ? String(el.value) : (el.textContent ?? ''); })()`;
    const result = await state.webManager.executeJs(sessionId, code);
    if (typeof result !== 'string') throw new BadRequest('selector matched no element on the page.');
    return result.trim();
  }
  throw new BadRequest('Give pattern (terminal) or selector (web page).');
}

export async function handleSecretRequest(
  request: { type: string; payload?: Record<string, unknown> },
  state: AppState,
  agent: AgentIdentity | null,
): Promise<IpcResponse> {
  const vault = state.getActiveVault();
  if (!vault.isUnlocked()) return lockedResponse(state, 'Vault is locked');
  const payload = request.payload ?? {};
  const sv = vault as unknown as SecretVault;

  try {
    switch (request.type) {
      case 'SecretCreate': {
        const ownerId = ownerIdOf(payload, state);
        const value = valueFrom(payload);
        const created = vault.runNonInteractive(() => createEmbeddedSecret(sv, ownerId, String(payload.label ?? ''), value));
        notifyRendererEntryChanged();
        return successResponse({ ...created, length: value.length });
      }
      case 'SecretRotate': {
        const id = secretIdOf(payload.secret);
        const value = valueFrom(payload);
        const staged = vault.runNonInteractive(() => stageRotation(sv, id, value));
        notifyRendererEntryChanged();
        return successResponse({ id, pending_ref: staged.pendingRef, length: value.length });
      }
      case 'SecretCommit': {
        const id = secretIdOf(payload.secret);
        vault.runNonInteractive(() => commitRotation(sv, id, agentDisplayName(agent)));
        notifyRendererEntryChanged();
        return successResponse({ id, committed: true });
      }
      case 'SecretDiscard': {
        const id = secretIdOf(payload.secret);
        const discarded = vault.runNonInteractive(() => discardRotation(sv, id));
        notifyRendererEntryChanged();
        return successResponse({ id, discarded });
      }
      case 'SecretCapture': {
        const ownerId = ownerIdOf(payload, state);
        const value = await captureValue(payload, state);
        if (!value) throw new BadRequest('The captured value is empty.');
        if (value.length > MAX_CAPTURE_LENGTH) throw new BadRequest(`The captured value is longer than ${MAX_CAPTURE_LENGTH} characters.`);
        const created = vault.runNonInteractive(() => createEmbeddedSecret(sv, ownerId, String(payload.label ?? ''), value));
        notifyRendererEntryChanged();
        return successResponse({ ...created, length: value.length });
      }
      default:
        return errorResponse('UNKNOWN_REQUEST', `Unknown secret request ${request.type}`);
    }
  } catch (e) {
    if (e instanceof BadRequest) return errorResponse('INVALID_ARGUMENT', e.message);
    return vaultFailure('SECRET_ERROR', e);
  }
}
