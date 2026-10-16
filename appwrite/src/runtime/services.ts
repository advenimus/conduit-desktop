import { AppwriteException, type Client, Query, Storage, Teams, Users } from 'node-appwrite';
import { InputFile } from 'node-appwrite/file';
import type { Directory } from '../api/context.ts';
import { type FileStore, STAGING_BUCKET } from '../api/storage.ts';

export class AppwriteFiles implements FileStore {
  private readonly storage: Storage;
  private readonly client: Client;

  constructor(client: Client) {
    this.storage = new Storage(client);
    this.client = client;
  }

  async put(bucket: string, fileId: string, name: string, bytes: Buffer): Promise<void> {
    await this.storage.createFile({ bucketId: bucket, fileId, file: InputFile.fromBuffer(bytes, name.split('/').pop() || 'file') });
  }

  // Plain HTTP, because the SDK parses a JSON file into an object instead of returning its bytes.
  async get(bucket: string, fileId: string): Promise<Buffer | null> {
    const { endpoint, project, key } = this.client.config as { endpoint: string; project: string; key: string };
    const res = await fetch(`${endpoint}/storage/buckets/${encodeURIComponent(bucket)}/files/${encodeURIComponent(fileId)}/download`, {
      headers: { 'X-Appwrite-Project': project, 'X-Appwrite-Key': key },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`file download ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async staged(fileId: string): Promise<{ bytes: Buffer; owner: string | null } | null> {
    let file;
    try {
      file = await this.storage.getFile({ bucketId: STAGING_BUCKET, fileId });
    } catch (e) {
      if (e instanceof AppwriteException && e.code === 404) return null;
      throw e;
    }
    // Appwrite gives the creating user read/update/delete on a file made without explicit permissions.
    const owner = file.$permissions.map((p) => /^delete\("user:([^"]+)"\)$/.exec(p)?.[1]).find(Boolean) ?? null;
    const bytes = await this.get(STAGING_BUCKET, fileId);
    return bytes ? { bytes, owner } : null;
  }

  async allowRead(bucket: string, fileId: string, userId: string): Promise<void> {
    const file = await this.storage.getFile({ bucketId: bucket, fileId });
    const want = `read("user:${userId}")`;
    if (file.$permissions.includes(want)) return;
    await this.storage.updateFile({ bucketId: bucket, fileId, permissions: [...file.$permissions, want] });
  }

  async delete(bucket: string, fileId: string): Promise<void> {
    try {
      await this.storage.deleteFile({ bucketId: bucket, fileId });
    } catch (e) {
      if (!(e instanceof AppwriteException && e.code === 404)) throw e;
    }
  }
}

export class AppwriteDirectory implements Directory {
  private readonly users: Users;
  private readonly cache = new Map<string, string | null>();

  constructor(client: Client) {
    this.users = new Users(client);
  }

  async exists(userId: string): Promise<boolean> {
    return (await this.emails([userId])).has(userId);
  }

  async emails(userIds: readonly string[]): Promise<Map<string, string>> {
    const missing = [...new Set(userIds)].filter((id) => !this.cache.has(id));
    for (let i = 0; i < missing.length; i += 100) {
      const chunk = missing.slice(i, i + 100);
      const found = await this.users.list({ queries: [Query.equal('$id', chunk), Query.limit(100)], total: false });
      for (const id of chunk) this.cache.set(id, null);
      for (const user of found.users) this.cache.set(user.$id, user.email);
    }
    const out = new Map<string, string>();
    for (const id of userIds) {
      const email = this.cache.get(id);
      if (email !== null && email !== undefined) out.set(id, email);
    }
    return out;
  }
}

/** Each team vault has an Appwrite team with the same ID, so Realtime only reaches its members. */
export async function syncVaultTeam(client: Client, vaultId: string, userId: string, role: string | null): Promise<void> {
  const teams = new Teams(client);
  const memberships = async () =>
    (await teams.listMemberships({ teamId: vaultId, queries: [Query.equal('userId', [userId])] })).memberships;
  let current: Awaited<ReturnType<typeof memberships>>;
  try {
    current = await memberships();
  } catch (e) {
    if (!(e instanceof AppwriteException && e.code === 404)) throw e;
    if (role === null) return;
    await teams.create({ teamId: vaultId, name: `vault ${vaultId}`, roles: ['admin', 'editor', 'viewer'] });
    current = [];
  }
  if (role === null) {
    for (const m of current) await teams.deleteMembership({ teamId: vaultId, membershipId: m.$id });
    return;
  }
  if (current.length === 0) {
    await teams.createMembership({ teamId: vaultId, roles: [role], userId });
  } else if (current[0]!.roles.join(',') !== role) {
    await teams.updateMembership({ teamId: vaultId, membershipId: current[0]!.$id, roles: [role] });
  }
}
