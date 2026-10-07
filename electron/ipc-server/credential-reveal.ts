/**
 * credential_read and secret_reveal: agents get metadata plus refs they can type with. The plain
 * value comes back only after the user clicks Allow in the reveal dialog.
 */

import { readEmbedded } from '../services/knowledge/kb-model.js';
import type { ApprovalManager } from '../services/reveal-approvals.js';
import { formatSecretRef } from '../services/secrets/secret-refs.js';
import { agentDisplayName } from './agent-names.js';
import { errorResponse, successResponse, type IpcResponse } from './ipc-response.js';
import type { AgentIdentity } from './session-claims.js';
import { hasConflict, vaultFailure, type VaultGuardState } from './vault-guard.js';

interface RevealCredential {
  id: string;
  name: string;
  username: string | null;
  password: string | null;
  domain: string | null;
  private_key: string | null;
  totp_secret: string | null;
  tags: string[];
  credential_type: string | null;
  public_key: string | null;
  fingerprint: string | null;
  totp_issuer: string | null;
  totp_label: string | null;
  totp_algorithm: string | null;
  totp_digits: number | null;
  totp_period: number | null;
  created_at: string;
  updated_at: string;
}

interface RevealVault {
  getCredential(id: string): RevealCredential;
  getEntryMeta(id: string): { name: string; config: Record<string, unknown> };
}

export interface RevealState extends VaultGuardState {
  approvalManager: ApprovalManager;
  getActiveVault(): object;
}

export function passwordRefFor(id: string, name: string, embedded: boolean): string {
  return embedded ? formatSecretRef(id, name) : `{{cred:${id}}}`;
}

export async function credentialGetResponse(
  payload: Record<string, unknown>,
  state: RevealState,
  agent: AgentIdentity | null,
): Promise<IpcResponse> {
  const id = typeof payload.id === 'string' ? payload.id : '';
  const vault = state.getActiveVault() as RevealVault;
  let cred: RevealCredential;
  let config: Record<string, unknown>;
  try {
    cred = vault.getCredential(id);
    config = vault.getEntryMeta(id).config ?? {};
  } catch (e) {
    return vaultFailure('VAULT_ERROR', e);
  }

  const embedded = readEmbedded(config);
  const meta = {
    id: cred.id,
    name: cred.name,
    username: cred.username,
    domain: cred.domain,
    tags: cred.tags,
    credential_type: cred.credential_type ?? null,
    public_key: cred.public_key ?? null,
    fingerprint: cred.fingerprint ?? null,
    has_password: !!cred.password,
    has_private_key: !!cred.private_key,
    password_ref: cred.password ? passwordRefFor(cred.id, cred.name, !!embedded) : null,
    has_totp: !!cred.totp_secret,
    totp_ref: cred.totp_secret ? `{{cred:${cred.id}.totp}}` : null,
    totp_issuer: cred.totp_issuer ?? null,
    totp_label: cred.totp_label ?? null,
    totp_algorithm: cred.totp_algorithm ?? null,
    totp_digits: cred.totp_digits ?? null,
    totp_period: cred.totp_period ?? null,
    created_at: cred.created_at,
    updated_at: cred.updated_at,
    has_conflict: hasConflict(state, cred.id),
  };

  if (payload.reveal !== true) return successResponse({ ...meta, password: null, private_key: null, revealed: false });

  const purpose = typeof payload.purpose === 'string' ? payload.purpose.trim() : '';
  if (!purpose) return errorResponse('INVALID_ARGUMENT', 'Say why you need to see the value in purpose; the user reads it before deciding.');

  let ownerName: string | null = null;
  if (embedded) {
    try {
      ownerName = vault.getEntryMeta(embedded.owner_id).name;
    } catch {
      ownerName = null;
    }
  }

  const approved = await state.approvalManager.request({
    agent_name: agentDisplayName(agent),
    kind: embedded ? 'secret' : 'credential',
    target_id: cred.id,
    target_name: cred.name,
    owner_name: ownerName,
    purpose: purpose.slice(0, 500),
  });
  if (!approved) {
    return errorResponse(
      'APPROVAL_DENIED',
      `The user did not allow showing this value. To type it without seeing it, use ${meta.password_ref ?? 'the ref'} in a typing tool.`,
    );
  }
  // Read again: the vault may have locked while the dialog was open.
  try {
    const fresh = vault.getCredential(id);
    return successResponse({ ...meta, password: fresh.password, private_key: fresh.private_key, revealed: true });
  } catch (e) {
    return vaultFailure('VAULT_ERROR', e);
  }
}
