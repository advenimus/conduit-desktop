import { RD_GATEWAY_CREDENTIAL_TYPE } from '../lib/rdpGateway';

export type CredentialType = 'generic' | 'ssh_key' | 'rd_gateway';

export const CREDENTIAL_TYPES: Record<CredentialType, { label: string; description: string }> = {
  generic: { label: 'Generic', description: 'Username, password, domain, private key' },
  ssh_key: { label: 'SSH Key', description: 'SSH key pair with public key and fingerprint' },
  rd_gateway: { label: 'RD Gateway', description: 'Remote Desktop Gateway that RDP entries connect through' },
};

/** Resolve a raw credential_type string to a known type. Falls back to 'generic'. */
export function resolveCredentialType(raw: string | null | undefined): CredentialType {
  if (raw === 'ssh_key') return 'ssh_key';
  if (raw === RD_GATEWAY_CREDENTIAL_TYPE) return 'rd_gateway';
  return 'generic';
}

/** A gateway is its own vault object, not a login, so login pickers leave it out. */
export function isLoginCredentialType(raw: string | null | undefined): boolean {
  return raw !== RD_GATEWAY_CREDENTIAL_TYPE;
}

export function loginCredentials<T extends { credential_type: string | null }>(credentials: readonly T[]): T[] {
  return credentials.filter((c) => isLoginCredentialType(c.credential_type));
}

export interface CredentialMeta {
  id: string;
  name: string;
  username: string | null;
  domain: string | null;
  tags: string[];
  credential_type: string | null;
  created_at: string;
}

export interface CredentialDto {
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
  ssh_auth_method: string | null;
  created_at: string;
  updated_at: string;
}
