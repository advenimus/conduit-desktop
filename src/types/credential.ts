export type CredentialType = 'generic' | 'ssh_key';

export const CREDENTIAL_TYPES: Record<CredentialType, { label: string; description: string }> = {
  generic: { label: 'Generic', description: 'Username, password, domain, private key' },
  ssh_key: { label: 'SSH Key', description: 'SSH key pair with public key and fingerprint' },
};

/** Resolve a raw credential_type string to a known type. Falls back to 'generic'. */
export function resolveCredentialType(raw: string | null | undefined): CredentialType {
  if (raw === 'ssh_key') return 'ssh_key';
  return 'generic';
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
