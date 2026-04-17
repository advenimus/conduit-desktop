export type SshKeyType = 'ed25519' | 'rsa' | 'ecdsa';
export type RsaBits = 2048 | 4096;
export type EcdsaCurve = 'P-256' | 'P-384' | 'P-521';

export interface SshKeyGenSettings {
  type: SshKeyType;
  rsaBits: RsaBits;
  ecdsaCurve: EcdsaCurve;
  passphrase: string;
  comment: string;
}

export interface SshKeyGenResult {
  privateKey: string;
  publicKey: string;
  fingerprint: string;
}

export const defaultSshKeySettings: SshKeyGenSettings = {
  type: 'ed25519',
  rsaBits: 4096,
  ecdsaCurve: 'P-256',
  passphrase: '',
  comment: '',
};
