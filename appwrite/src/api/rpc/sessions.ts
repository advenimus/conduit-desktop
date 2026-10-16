import { randomUUID } from 'node:crypto';
import { tableSpec } from '../../schema/tables.ts';
import { coerce, rowIdFor } from '../codec.ts';
import type { Ctx } from '../context.ts';
import type { Engine } from '../engine.ts';
import { ApiError } from '../errors.ts';
import type { Row } from '../filters.ts';
import { appMinVersion, appVersionOk } from './versions.ts';

// Port of the personal vault lease RPCs (vault_session_*, vault_owner_*). The answers keep the jsonb
// shapes of the SQL functions; the SQL advisory locks become guard scopes.

const S = tableSpec('personal_vault_sessions');
const OWNERS = tableSpec('personal_vault_owners');
const GRACE = tableSpec('personal_vault_guest_grace');
const DAY = 86_400;

type Json = Record<string, unknown>;

const ms = (iso: unknown): number => (typeof iso === 'string' ? Date.parse(iso) : NaN);
const isBusy = (busy: unknown): boolean => {
  const b = (busy && typeof busy === 'object' ? busy : {}) as Record<string, unknown>;
  return (typeof b.sessions === 'number' && b.sessions > 0) || (typeof b.jobs === 'number' && b.jobs > 0);
};
const num = (v: unknown): number => (typeof v === 'number' ? Math.max(v, 0) : 0);
const left = (v: unknown, n: number): unknown => (typeof v === 'string' ? [...v].slice(0, n).join('') : v);

/** uuid ordering in Postgres equals lowercase hex string ordering. */
const cmpId = (a: unknown, b: unknown) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

function uuidArg(args: Json, name: string, required = false): string | null {
  const v = args[name];
  if (v === null || v === undefined) {
    if (required) throw new ApiError('22023', 'missing id');
    return null;
  }
  return coerce(S, 'lease_id', v) as string;
}

export class Sessions {
  readonly ctx: Ctx;
  readonly engine: Engine;

  /** engine must run as definer (SECURITY DEFINER in SQL). */
  constructor(ctx: Ctx, engine: Engine) {
    this.ctx = ctx;
    this.engine = engine;
  }

  private get uow() {
    return this.ctx.uow;
  }

  private now(plus = 0): string {
    return this.uow.nowIso(plus);
  }

  private live(r: Row): boolean {
    return r.status === 'active' && ms(r.expires_at) >= this.uow.now;
  }

  private async userRows(uid: string): Promise<Row[]> {
    return this.uow.list(S, [{ column: 'user_id', op: 'eq', value: uid }]);
  }

  private async vaultRows(uid: string, vaultKey: string): Promise<Row[]> {
    return this.uow.list(S, [
      { column: 'user_id', op: 'eq', value: uid },
      { column: 'vault_key', op: 'eq', value: vaultKey },
    ]);
  }

  private async sessionRow(uid: string, vaultKey: string, deviceId: string): Promise<Row | null> {
    return this.uow.get(S, rowIdFor(S, { user_id: uid, vault_key: vaultKey, device_id: deviceId }));
  }

  private async patch(row: Row, patch: Row): Promise<Row> {
    return this.engine.updateRow(S, row, patch);
  }

  // ---- plan numbers ------------------------------------------------------------------------------

  async deviceLimit(uid: string): Promise<number | null> {
    const profile = await this.ctx.profile(uid);
    if (!profile) return null;
    if (profile.is_team_member === true) return -1;
    const tier = profile.tier_id ? await this.uow.get(tableSpec('tiers'), profile.tier_id as string) : null;
    const f = (tier?.features ?? {}) as Record<string, unknown>;
    if (f.vault_max_open_devices !== undefined && f.vault_max_open_devices !== null) return Math.trunc(Number(f.vault_max_open_devices));
    return tier && (tier.name === 'pro' || tier.name === 'team') ? -1 : 1;
  }

  async accountCap(uid: string): Promise<number> {
    const tier = await this.ctx.tierOf(uid);
    const v = (tier?.features as Record<string, unknown> | undefined)?.account_max_active_devices;
    if (typeof v === 'number') return Math.trunc(v);
    return this.ctx.configInt('account_max_active_devices_fallback', 5);
  }

  // ---- read helpers (vault_session_holders, vault_sessions_for, ...) ------------------------------

  async holders(uid: string, vaultKey: string, deviceId: string): Promise<Json[]> {
    return (await this.vaultRows(uid, vaultKey))
      .filter((r) => this.live(r) && r.device_id !== deviceId)
      .sort((a, b) => ms(b.last_active_at) - ms(a.last_active_at))
      .map((r) => ({
        device_id: r.device_id, device_name: r.device_name, platform: r.platform, file_name: r.file_name,
        file_id: r.file_id, location: r.location, last_active_at: r.last_active_at, busy: r.busy,
      }));
  }

  async sessionsFor(uid: string, vaultKey: string, deviceId: string): Promise<Json[]> {
    const since = this.uow.now - 30 * DAY * 1000;
    return (await this.vaultRows(uid, vaultKey))
      .filter((r) => r.device_id !== deviceId && ms(r.heartbeat_at) > since)
      .sort((a, b) => ms(b.last_active_at) - ms(a.last_active_at))
      .map((r) => ({
        device_id: r.device_id, device_name: r.device_name, platform: r.platform, file_name: r.file_name,
        file_id: r.file_id, location: r.location,
        status: r.status === 'active' && ms(r.expires_at) < this.uow.now ? 'expired' : r.status,
        last_active_at: r.last_active_at, heartbeat_at: r.heartbeat_at, busy: r.busy, flags: r.flags,
        written_vv: r.written_vv, written_at: r.written_at, pending_changes: r.pending_changes,
        abandoned: r.abandoned_at !== null,
      }));
  }

  private groupDevices(rows: Row[]) {
    const byDevice = new Map<string, Row[]>();
    for (const r of rows) {
      const list = byDevice.get(r.device_id as string) ?? [];
      list.push(r);
      byDevice.set(r.device_id as string, list);
    }
    return [...byDevice.entries()].map(([device_id, list]) => ({
      device_id,
      rows: list,
      is_busy: list.some((r) => isBusy(r.busy)),
      la: Math.max(...list.map((r) => ms(r.last_active_at))),
    }));
  }

  private latestRow(rows: Row[]): Row {
    return [...rows].sort((a, b) => ms(b.last_active_at) - ms(a.last_active_at))[0]!;
  }

  async deviceHolders(uid: string, deviceId: string): Promise<Json[]> {
    const live = (await this.userRows(uid)).filter((r) => this.live(r) && r.device_id !== deviceId);
    return this.groupDevices(live)
      .sort((a, b) => Number(a.is_busy) - Number(b.is_busy) || a.la - b.la || cmpId(a.device_id, b.device_id))
      .map((d) => {
        const l = this.latestRow(d.rows);
        return {
          device_id: d.device_id, device_name: l.device_name, platform: l.platform, file_name: l.file_name,
          file_id: l.file_id, location: l.location, last_active_at: new Date(d.la).toISOString(),
          busy: {
            sessions: d.rows.reduce((s, r) => s + num((r.busy as Record<string, unknown>)?.sessions), 0),
            jobs: d.rows.reduce((s, r) => s + num((r.busy as Record<string, unknown>)?.jobs), 0),
          },
          vaults: d.rows.length,
        };
      });
  }

  async overCap(uid: string, vaultKey: string, deviceId: string, cap: number): Promise<boolean> {
    if (cap === -1) return false;
    const rows = await this.userRows(uid);
    if (rows.some((r) => r.device_id === deviceId && r.vault_key !== vaultKey && this.live(r))) return false;
    const devices = new Set(rows.filter((r) => this.live(r) && r.device_id !== deviceId).map((r) => r.device_id));
    return devices.size >= cap;
  }

  async capVictim(uid: string, vaultKey: string, deviceId: string, cap: number, skip: readonly unknown[]): Promise<Json | null> {
    const rows = await this.userRows(uid);
    const live = rows.filter((r) => this.live(r) && r.device_id !== deviceId && !(r.vault_key === vaultKey && skip.includes(r.device_id)));
    const devs = this.groupDevices(live);
    if (cap === -1 || devs.length < cap) return null;
    if (rows.some((r) => r.device_id === deviceId && r.vault_key !== vaultKey && this.live(r))) return null;
    const d = devs.sort((a, b) => Number(a.is_busy) - Number(b.is_busy) || a.la - b.la || cmpId(a.device_id, b.device_id))[0]!;
    return { device_id: d.device_id, device_name: this.latestRow(d.rows).device_name };
  }

  // ---- ownership (vault_owner_resolve) -----------------------------------------------------------

  async resolveOwner(uid: string, vaultKey: string, write: boolean, claim: boolean): Promise<Json> {
    const days = await this.ctx.configInt('vault_share_grace_days', 14);
    const cool = await this.ctx.configInt('vault_release_cooldown_days', 7);
    if (write && claim && !(await this.uow.get(OWNERS, vaultKey))) {
      await this.engine.insertRow(OWNERS, { vault_key: vaultKey, owner_id: uid, owner_since: this.now() });
    }
    let v = await this.uow.get(OWNERS, vaultKey);
    if (!v) return { ownership: 'unowned' };

    if (v.owner_id === null) {
      if (!(write && claim)) return { ownership: 'unowned' };
      await this.engine.updateRow(OWNERS, v, { owner_id: uid, owner_since: this.now(), released_at: null, updated_at: this.now() });
      return { ownership: 'owner', release_after: this.now(cool * DAY), shared_until: null };
    }

    if (v.owner_id === uid) {
      const shared = v.grace_started_at ? ms(v.grace_started_at) + days * DAY * 1000 : null;
      return {
        ownership: 'owner',
        release_after: new Date(ms(v.owner_since) + cool * DAY * 1000).toISOString(),
        shared_until: shared !== null && shared > this.uow.now ? new Date(shared).toISOString() : null,
      };
    }

    const [lo, hi] = cmpId(v.owner_id, uid) < 0 ? [v.owner_id as string, uid] : [uid, v.owner_id as string];
    if (write) {
      if (!(await this.uow.get(GRACE, rowIdFor(GRACE, { account_lo: lo, account_hi: hi })))) {
        await this.engine.insertRow(GRACE, { account_lo: lo, account_hi: hi });
      }
      if (v.grace_started_at === null) {
        v = await this.engine.updateRow(OWNERS, v, { grace_started_at: this.now(), updated_at: this.now() });
      }
    }
    const pair = await this.uow.get(GRACE, rowIdFor(GRACE, { account_lo: lo, account_hi: hi }));
    const start = Math.min(v.grace_started_at ? ms(v.grace_started_at) : this.uow.now, pair ? ms(pair.started_at) : this.uow.now);
    const until = new Date(start + days * DAY * 1000).toISOString();
    if (this.uow.now < ms(until)) return { ownership: 'grace', grace_until: until };
    return { ownership: 'not_owner', grace_ended_at: until, released: v.released_by === uid };
  }

  async displacedAnswer(uid: string, vaultKey: string, reason: unknown, byDevice: unknown, platform: unknown): Promise<Json> {
    if (reason === 'not_owner') {
      const own = await this.resolveOwner(uid, vaultKey, false, false);
      return { status: 'displaced', reason, by: null, grace_ended_at: own.grace_ended_at ?? null, released: own.released === true };
    }
    if (reason === 'update_required') {
      return { status: 'displaced', reason, by: null, min_version: await appMinVersion(this.ctx, platform) };
    }
    const by = (await this.userRows(uid))
      .filter((r) => r.device_id === byDevice)
      .sort((a, b) => ms(b.heartbeat_at) - ms(a.heartbeat_at))[0];
    return { status: 'displaced', reason, by: by ? by.device_name : null };
  }

  // ---- RPCs --------------------------------------------------------------------------------------

  async peek(args: Json): Promise<Json | null> {
    const uid = this.ctx.uid;
    if (!uid) return null;
    const vaultKey = uuidArg(args, 'p_vault_key');
    const deviceId = uuidArg(args, 'p_device_id');
    const platform = args.p_platform ?? null;
    const limit = (await this.deviceLimit(uid)) ?? 1;
    const cap = await this.accountCap(uid);
    const out: Json = { limit, device_cap: cap, holders: await this.holders(uid, vaultKey!, deviceId!) };
    if (platform !== null && !(await appVersionOk(this.ctx, platform, args.p_app_version ?? null))) {
      return { ...out, reason: 'update_required', min_version: await appMinVersion(this.ctx, platform) };
    }
    if (await this.overCap(uid, vaultKey!, deviceId!, cap)) {
      return { ...out, reason: 'device_cap', devices: await this.deviceHolders(uid, deviceId!) };
    }
    return out;
  }

  async acquire(args: Json): Promise<Json> {
    const uid = this.ctx.requireUid();
    const vaultKey = uuidArg(args, 'p_vault_key', true)!;
    const deviceId = uuidArg(args, 'p_device_id', true)!;
    const nonce = uuidArg(args, 'p_session_nonce', true)!;
    const platform = args.p_platform ?? null;
    const appVersion = args.p_app_version ?? null;
    const takeover = args.p_takeover === true;
    const claim = args.p_claim === undefined || args.p_claim === null ? true : args.p_claim === true;
    const limit = (await this.deviceLimit(uid)) ?? 1;
    const serverNow = this.now();

    if (!(await appVersionOk(this.ctx, platform, appVersion))) {
      return { granted: false, reason: 'update_required', limit, min_version: await appMinVersion(this.ctx, platform), holders: [], sessions: [], server_now: serverNow };
    }

    await this.uow.guard(`vault-acct:${uid}`);
    const dayAgo = this.uow.now - DAY * 1000;
    if ((await this.userRows(uid)).filter((r) => ms(r.heartbeat_at) > dayAgo).length > 200) {
      return { granted: false, error: 'too_many_sessions' };
    }

    await this.uow.guard(`vault-owner:${vaultKey}`);
    let own = await this.resolveOwner(uid, vaultKey, false, false);
    if (own.ownership === 'not_owner') {
      return {
        granted: false, reason: 'not_owner', limit, grace_ended_at: own.grace_ended_at ?? null, released: own.released === true,
        holders: [], sessions: [], server_now: serverNow,
      };
    }

    for (const r of await this.userRows(uid)) {
      if (r.status === 'active' && ms(r.expires_at) < this.uow.now) await this.patch(r, { status: 'expired' });
    }

    const cap = await this.accountCap(uid);

    if (limit !== -1) {
      const others = (await this.vaultRows(uid, vaultKey)).filter((r) => r.status === 'active' && r.device_id !== deviceId);
      if (others.length >= limit) {
        const victims = others
          .sort((a, b) => Number(isBusy(a.busy)) - Number(isBusy(b.busy)) || ms(a.last_active_at) - ms(b.last_active_at) || cmpId(a.device_id, b.device_id))
          .slice(0, others.length - limit + 1)
          .map((r) => r.device_id);
        if (!takeover) {
          return {
            granted: false, reason: 'vault_limit', limit, device_cap: cap,
            also_locks: await this.capVictim(uid, vaultKey, deviceId, cap, victims),
            holders: await this.holders(uid, vaultKey, deviceId),
            sessions: await this.sessionsFor(uid, vaultKey, deviceId), server_now: serverNow,
          };
        }
        for (const r of await this.vaultRows(uid, vaultKey)) {
          if (victims.includes(r.device_id)) {
            await this.patch(r, { status: 'displaced', displaced_by_device: deviceId, displaced_reason: 'takeover', displaced_at: this.now() });
          }
        }
      }
    }

    if (await this.overCap(uid, vaultKey, deviceId, cap)) {
      if (!takeover) {
        return {
          granted: false, reason: 'device_cap', limit, device_cap: cap,
          holders: await this.deviceHolders(uid, deviceId),
          sessions: await this.sessionsFor(uid, vaultKey, deviceId), server_now: serverNow,
        };
      }
      const live = (await this.userRows(uid)).filter((r) => this.live(r) && r.device_id !== deviceId);
      const devs = this.groupDevices(live).sort((a, b) => Number(a.is_busy) - Number(b.is_busy) || a.la - b.la || cmpId(a.device_id, b.device_id));
      const victims = devs.slice(0, devs.length - cap + 1).map((d) => d.device_id);
      for (const r of await this.userRows(uid)) {
        if (r.status === 'active' && victims.includes(r.device_id as string)) {
          await this.patch(r, { status: 'displaced', displaced_by_device: deviceId, displaced_reason: 'device_cap', displaced_at: this.now() });
        }
      }
    }

    own = await this.resolveOwner(uid, vaultKey, true, claim);

    const lease = randomUUID();
    const values: Row = {
      lease_id: lease, session_nonce: nonce, device_name: left(args.p_device_name ?? null, 120), platform,
      app_version: left(appVersion, 40), file_name: left(args.p_file_name ?? null, 255), file_id: uuidArg(args, 'p_file_id'),
      location: left(args.p_location ?? null, 120), status: 'active', acquired_at: this.now(), heartbeat_at: this.now(),
      expires_at: this.now(90), last_active_at: this.now(), busy: {}, flags: {}, abandoned_at: null,
      displaced_by_device: null, displaced_reason: null, displaced_at: null,
    };
    const existing = await this.sessionRow(uid, vaultKey, deviceId);
    if (existing) await this.patch(existing, values);
    else await this.engine.insertRow(S, { user_id: uid, vault_key: vaultKey, device_id: deviceId, ...values });

    return {
      granted: true, lease_id: lease, limit, device_cap: cap, ownership: own.ownership, grace_until: own.grace_until ?? null,
      release_after: own.release_after ?? null, shared_until: own.shared_until ?? null, ttl_seconds: 90, heartbeat_seconds: 30,
      sessions: await this.sessionsFor(uid, vaultKey, deviceId), server_now: serverNow,
    };
  }

  async heartbeat(args: Json): Promise<Json> {
    const uid = this.ctx.requireUid();
    const vaultKey = uuidArg(args, 'p_vault_key')!;
    const deviceId = uuidArg(args, 'p_device_id')!;
    const leaseId = uuidArg(args, 'p_lease_id');
    await this.uow.guard(`vault-acct:${uid}`);

    let row = await this.sessionRow(uid, vaultKey, deviceId);
    if (!row) return { status: 'lost', reason: 'unknown' };
    if (row.lease_id !== leaseId) return { status: 'lost', reason: 'superseded' };
    const snapshot = row;

    const writtenVv = args.p_written_vv ?? null;
    const patch: Row = {
      pending_changes: args.p_pending ?? row.pending_changes,
      file_name: args.p_file_name === null || args.p_file_name === undefined ? row.file_name : left(args.p_file_name, 255),
      file_id: uuidArg(args, 'p_file_id') ?? row.file_id,
      location: args.p_location === null || args.p_location === undefined ? row.location : left(args.p_location, 120),
      busy: args.p_busy ?? row.busy,
      flags: args.p_flags ?? row.flags,
    };
    if (writtenVv !== null) Object.assign(patch, { written_vv: writtenVv, written_at: this.now(), abandoned_at: null });
    row = await this.patch(row, patch);

    if (snapshot.status === 'displaced') {
      return this.displacedAnswer(uid, vaultKey, snapshot.displaced_reason, snapshot.displaced_by_device, snapshot.platform);
    }
    if (snapshot.status !== 'active' || ms(snapshot.expires_at) < this.uow.now) {
      if (row.status === 'active') await this.patch(row, { status: 'expired' });
      return { status: 'lost', reason: snapshot.status === 'released' ? 'released' : 'expired' };
    }
    if (!(await appVersionOk(this.ctx, snapshot.platform, snapshot.app_version))) {
      await this.patch(row, { status: 'displaced', displaced_reason: 'update_required', displaced_at: this.now(), displaced_by_device: null });
      return { status: 'displaced', reason: 'update_required', by: null, min_version: await appMinVersion(this.ctx, snapshot.platform) };
    }
    const own = await this.resolveOwner(uid, vaultKey, false, false);
    if (own.ownership === 'not_owner') {
      await this.patch(row, { status: 'displaced', displaced_reason: 'not_owner', displaced_at: this.now(), displaced_by_device: null });
      return { status: 'displaced', reason: 'not_owner', by: null, grace_ended_at: own.grace_ended_at ?? null, released: own.released === true };
    }

    row = await this.patch(row, {
      heartbeat_at: this.now(),
      expires_at: this.now(90),
      last_active_at: args.p_active === true ? this.now() : row.last_active_at,
    });

    const limit = (await this.deviceLimit(uid)) ?? 1;
    if (limit !== -1) {
      const ranked = (await this.vaultRows(uid, vaultKey))
        .filter((r) => this.live(r))
        .sort((a, b) => Number(isBusy(b.busy)) - Number(isBusy(a.busy)) || ms(b.last_active_at) - ms(a.last_active_at) || cmpId(a.device_id, b.device_id));
      const keeper = ranked[0]?.device_id ?? null;
      for (const r of ranked.slice(limit)) {
        await this.patch(r, { status: 'displaced', displaced_reason: 'plan_limit', displaced_at: this.now(), displaced_by_device: keeper });
      }
    }

    const cap = await this.accountCap(uid);
    if (cap !== -1) {
      const devs = this.groupDevices((await this.userRows(uid)).filter((r) => this.live(r)))
        .sort((a, b) => Number(b.is_busy) - Number(a.is_busy) || b.la - a.la || cmpId(a.device_id, b.device_id));
      const keeper = devs[0]?.device_id ?? null;
      const losers = new Set(devs.slice(cap).map((d) => d.device_id));
      for (const r of await this.userRows(uid)) {
        if (r.status === 'active' && losers.has(r.device_id as string)) {
          await this.patch(r, { status: 'displaced', displaced_reason: 'device_cap', displaced_at: this.now(), displaced_by_device: keeper });
        }
      }
    }

    row = (await this.sessionRow(uid, vaultKey, deviceId))!;
    if (row.status === 'displaced') {
      return this.displacedAnswer(uid, vaultKey, row.displaced_reason, row.displaced_by_device, row.platform);
    }
    return {
      status: 'ok', limit, device_cap: cap, ownership: own.ownership, grace_until: own.grace_until ?? null,
      release_after: own.release_after ?? null, shared_until: own.shared_until ?? null,
      sessions: await this.sessionsFor(uid, vaultKey, deviceId), server_now: this.now(),
    };
  }

  async release(args: Json): Promise<null> {
    const uid = this.ctx.requireUid();
    const vaultKey = uuidArg(args, 'p_vault_key')!;
    const deviceId = uuidArg(args, 'p_device_id')!;
    const leaseId = uuidArg(args, 'p_lease_id');
    await this.uow.guard(`vault-acct:${uid}`);
    const row = await this.sessionRow(uid, vaultKey, deviceId);
    if (!row || row.lease_id !== leaseId) return null;
    const writtenVv = args.p_written_vv ?? null;
    await this.patch(row, {
      status: row.status === 'active' ? 'released' : row.status,
      expires_at: new Date(Math.min(ms(row.expires_at), this.uow.now)).toISOString(),
      heartbeat_at: this.now(),
      pending_changes: args.p_pending ?? false,
      ...(writtenVv !== null ? { written_vv: writtenVv, written_at: this.now(), abandoned_at: null } : {}),
    });
    return null;
  }

  async abandon(args: Json): Promise<null> {
    const uid = this.ctx.requireUid();
    const vaultKey = uuidArg(args, 'p_vault_key')!;
    const deviceId = uuidArg(args, 'p_device_id');
    const target = uuidArg(args, 'p_target_device_id');
    if (target === deviceId || !target) return null;
    await this.uow.guard(`vault-acct:${uid}`);
    const row = await this.sessionRow(uid, vaultKey, target);
    if (row) await this.patch(row, { abandoned_at: this.now() });
    return null;
  }

  async ownerRelease(args: Json): Promise<Json> {
    const uid = this.ctx.requireUid();
    const vaultKey = uuidArg(args, 'p_vault_key', true)!;
    const cool = await this.ctx.configInt('vault_release_cooldown_days', 7);
    await this.uow.guard(`vault-owner:${vaultKey}`);
    const v = await this.uow.get(OWNERS, vaultKey);
    if (!v || v.owner_id !== uid) return { released: false, reason: 'not_owner' };
    const until = ms(v.owner_since) + cool * DAY * 1000;
    if (until > this.uow.now) return { released: false, reason: 'too_soon', retry_after: new Date(until).toISOString() };
    await this.engine.updateRow(OWNERS, v, { owner_id: null, owner_since: null, released_at: this.now(), released_by: uid, updated_at: this.now() });
    return { released: true };
  }
}
