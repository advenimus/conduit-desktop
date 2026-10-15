import { createHash } from 'node:crypto';
import type { Caller, Directory } from '../../src/api/context.ts';
import type { Row } from '../../src/api/filters.ts';
import { type ApiRequest, type ApiResponse, handle } from '../../src/api/handler.ts';
import type { FileStore } from '../../src/api/storage.ts';
import { MemoryStore } from '../../src/api/store.ts';
import type { Effects } from '../../src/api/triggers.ts';
import { tableSpec } from '../../src/schema/tables.ts';
import { rowIdFor } from '../../src/api/codec.ts';
import { SEED_CONFIG, SEED_TIERS } from '../../src/schema/seed.ts';

/** pg_temp.u from the old SQL tests: a stable uuid per name. */
export function u(name: string): string {
  const h = createHash('md5').update(`plan-enforcement-test:${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export class MemoryFiles implements FileStore {
  readonly blobs = new Map<string, Buffer>();
  async put(bucket: string, fileId: string, _name: string, bytes: Buffer): Promise<void> {
    this.blobs.set(`${bucket}/${fileId}`, Buffer.from(bytes));
  }
  async get(bucket: string, fileId: string): Promise<Buffer | null> {
    return this.blobs.get(`${bucket}/${fileId}`) ?? null;
  }
  async delete(bucket: string, fileId: string): Promise<void> {
    this.blobs.delete(`${bucket}/${fileId}`);
  }
  readonly stagedOwners = new Map<string, string>();
  readonly readers = new Map<string, Set<string>>();
  async staged(fileId: string): Promise<{ bytes: Buffer; owner: string | null } | null> {
    const bytes = this.blobs.get(`uploads/${fileId}`);
    return bytes ? { bytes, owner: this.stagedOwners.get(fileId) ?? null } : null;
  }
  async allowRead(bucket: string, fileId: string, userId: string): Promise<void> {
    const key = `${bucket}/${fileId}`;
    this.readers.set(key, new Set([...(this.readers.get(key) ?? []), userId]));
  }
}

export class World {
  readonly store = new MemoryStore();
  readonly files = new MemoryFiles();
  readonly users = new Map<string, string>();
  readonly effects: { kind: string; args: unknown[] }[] = [];
  clock = Date.parse('2026-10-14T12:00:00.000Z');

  readonly directory: Directory = {
    exists: async (id) => this.users.has(id),
    emails: async (ids) => new Map(ids.filter((id) => this.users.has(id)).map((id) => [id, this.users.get(id)!])),
  };

  readonly fx: Effects = {
    syncVaultMembership: async (...args) => void this.effects.push({ kind: 'vault-membership', args }),
    newUserProfile: async (...args) => void this.effects.push({ kind: 'new-profile', args }),
    feedbackSubmitted: async (...args) => void this.effects.push({ kind: 'feedback', args }),
    fileReleased: async (bucket, fileId) => {
      this.effects.push({ kind: 'file-released', args: [bucket, fileId] });
      await this.files.delete(bucket, fileId);
    },
  };

  get nowIso(): string {
    return new Date(this.clock).toISOString();
  }

  ago(seconds: number): string {
    return new Date(this.clock - seconds * 1000).toISOString();
  }

  static async create(): Promise<World> {
    const w = new World();
    for (const t of SEED_TIERS) await w.ok('service', { kind: 'query', op: 'insert', table: 'tiers', rows: t });
    for (const c of SEED_CONFIG) await w.ok('service', { kind: 'query', op: 'insert', table: 'app_config', rows: c });
    return w;
  }

  caller(who: string): Caller {
    if (who === 'service') return { role: 'service', uid: null, email: null };
    if (who === 'anon') return { role: 'anon', uid: null, email: null };
    return { role: 'authenticated', uid: u(who), email: `${who}@plan.test` };
  }

  async call(who: string, req: ApiRequest): Promise<ApiResponse> {
    return handle(req, this.caller(who), { store: this.store, files: this.files, directory: this.directory, effects: this.fx, now: () => this.clock });
  }

  async ok(who: string, req: ApiRequest): Promise<unknown> {
    const r = await this.call(who, req);
    if (r.body.error) throw new Error(`${who} ${JSON.stringify(req).slice(0, 200)} failed: ${r.body.error.code} ${r.body.error.message}`);
    return r.body.data;
  }

  async err(who: string, req: ApiRequest): Promise<string> {
    const r = await this.call(who, req);
    if (!r.body.error) throw new Error(`${who} expected an error, got success: ${JSON.stringify(req).slice(0, 200)}`);
    return `${r.body.error.code} ${r.body.error.message}`;
  }

  // ---- fixtures (the pg_temp helpers) ------------------------------------------------------------

  async mkUser(name: string, tier: 'free' | 'pro' | 'team' = 'free'): Promise<string> {
    const id = u(name);
    this.users.set(id, `${name}@plan.test`);
    const tierId = SEED_TIERS.find((t) => t.name === tier)!.id;
    await this.ok('service', { kind: 'query', op: 'insert', table: 'user_profiles', rows: { id, display_name: name, tier_id: tierId } });
    return id;
  }

  async setTier(name: string, tier: 'free' | 'pro' | 'team'): Promise<void> {
    const tierId = SEED_TIERS.find((t) => t.name === tier)!.id;
    await this.ok('service', { kind: 'query', op: 'update', table: 'user_profiles', values: { tier_id: tierId }, filters: [{ column: 'id', op: 'eq', value: u(name) }] });
  }

  async insert(table: string, rows: Row | Row[]): Promise<void> {
    await this.ok('service', { kind: 'query', op: 'insert', table, rows });
  }

  async update(table: string, values: Row, filters: { column: string; op: 'eq'; value: unknown }[]): Promise<void> {
    await this.ok('service', { kind: 'query', op: 'update', table, values, filters });
  }

  async rows(table: string, filters: { column: string; op: 'eq' | 'neq' | 'in'; value: unknown }[] = []): Promise<Row[]> {
    return (await this.ok('service', { kind: 'query', op: 'select', table, filters })) as Row[];
  }

  async row(table: string, key: Row): Promise<Row | null> {
    const spec = tableSpec(table);
    return this.store.get(spec, rowIdFor(spec, key));
  }

  async mkTeam(name: string, owner: string, seats = 5, sub: string | null = 'sub_test'): Promise<string> {
    const id = u(`team:${name}`);
    await this.insert('teams', { id, name, slug: `plan-test-${name}`, owner_id: u(owner), max_seats: seats, stripe_subscription_id: sub });
    return id;
  }

  async addMember(team: string, user: string, role: 'admin' | 'member' = 'member'): Promise<void> {
    await this.insert('team_members', { team_id: u(`team:${team}`), user_id: u(user), role });
  }

  async mkVault(team: string, name: string, creator: string): Promise<string> {
    const id = u(`tv:${name}`);
    await this.insert('team_vaults', { id, team_id: u(`team:${team}`), name, created_by: u(creator) });
    return id;
  }

  async addVaultMember(vault: string, user: string, role: 'admin' | 'editor' | 'viewer'): Promise<void> {
    await this.insert('team_vault_members', { team_vault_id: u(`tv:${vault}`), user_id: u(user), role });
  }

  // ---- lease helpers -----------------------------------------------------------------------------

  async acq(user: string, vault: string, device: string, opts: { takeover?: boolean; claim?: boolean; platform?: string | null; version?: string | null } = {}): Promise<Row> {
    return (await this.ok(user, {
      kind: 'rpc',
      fn: 'vault_session_acquire',
      args: {
        p_vault_key: u(vault), p_device_id: u(device), p_session_nonce: crypto.randomUUID(), p_device_name: `dev-${device}`,
        p_platform: opts.platform === undefined ? 'macos' : opts.platform, p_app_version: opts.version === undefined ? '0.18.0' : opts.version,
        p_file_name: 'v.conduit', p_file_id: null, p_location: null, p_takeover: opts.takeover ?? false, p_claim: opts.claim ?? true,
      },
    })) as Row;
  }

  async sess(user: string, vault: string, device: string): Promise<Row | null> {
    return this.row('personal_vault_sessions', { user_id: u(user), vault_key: u(vault), device_id: u(device) });
  }

  async hb(user: string, vault: string, device: string, active = true): Promise<Row> {
    const s = await this.sess(user, vault, device);
    return (await this.ok(user, {
      kind: 'rpc',
      fn: 'vault_session_heartbeat',
      args: { p_vault_key: u(vault), p_device_id: u(device), p_lease_id: s?.lease_id ?? null, p_active: active },
    })) as Row;
  }

  async peek(user: string, vault: string, device: string, platform: string | null = null, version: string | null = null): Promise<Row> {
    return (await this.ok(user, {
      kind: 'rpc', fn: 'vault_session_peek', args: { p_vault_key: u(vault), p_device_id: u(device), p_platform: platform, p_app_version: version },
    })) as Row;
  }

  async release(user: string, vault: string): Promise<Row> {
    return (await this.ok(user, { kind: 'rpc', fn: 'vault_owner_release', args: { p_vault_key: u(vault) } })) as Row;
  }

  /** pg_temp.live: a lease row written directly. */
  async live(user: string, vault: string, device: string, agoSeconds: number, busy: Row = {}): Promise<void> {
    await this.insert('personal_vault_sessions', {
      user_id: u(user), vault_key: u(vault), device_id: u(device), lease_id: crypto.randomUUID(), session_nonce: crypto.randomUUID(),
      device_name: `dev-${device}`, platform: 'macos', app_version: '0.18.0', status: 'active', acquired_at: this.ago(agoSeconds),
      heartbeat_at: this.nowIso, expires_at: new Date(this.clock + 90_000).toISOString(), last_active_at: this.ago(agoSeconds), busy,
    });
  }

  async ownerRow(vault: string): Promise<Row | null> {
    return this.row('personal_vault_owners', { vault_key: u(vault) });
  }

  async setMin(desktop: string, ios: string): Promise<void> {
    await this.update('app_config', { value: { desktop, ios } }, [{ column: 'key', op: 'eq', value: 'min_app_version' }]);
  }
}

export const days = (n: number) => n * 86_400;
