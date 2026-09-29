// In-memory emulation of the plan enforcement tables and helpers of docs/PLAN_ENFORCEMENT.md
// 2.2-2.4 (the DB builder's migrations are the reference): app_config (grace days, release
// cooldown, minimum versions), personal_vault_owners with the release cooldown and released_by,
// personal_vault_guest_grace (the pair clock), vault_owner_resolve, vault_owner_release and the
// version helpers. Test helper of fake-session-server.ts.

const DAY_MS = 24 * 60 * 60 * 1000;

export interface OwnerRow {
  readonly ownerId: string | null;
  readonly ownerSinceMs: number | null;
  readonly graceStartedMs: number | null;
  readonly releasedBy: string | null;
}

export type OwnerAnswer =
  | { readonly ownership: 'unowned' }
  | { readonly ownership: 'owner'; readonly release_after: string; readonly shared_until: string | null }
  | { readonly ownership: 'grace'; readonly grace_until: string }
  | { readonly ownership: 'not_owner'; readonly grace_ended_at: string; readonly released: boolean };

const iso = (ms: number): string => new Date(ms).toISOString();

/** version_parts: [major, minor, patch] from "1.2.3", "v0.18", "1.1.0 (107)"; null without a leading number. */
export function versionParts(v: string | null): readonly number[] | null {
  const m = /^\s*v?(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?/.exec(v ?? '');
  return m === null ? null : [Number(m[1]), Number(m[2] ?? '0'), Number(m[3] ?? '0')];
}

function compareParts(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function platformGroup(platform: string | null): 'desktop' | 'ios' | null {
  if (platform === 'macos' || platform === 'windows' || platform === 'linux') return 'desktop';
  if (platform === 'ios' || platform === 'ipados') return 'ios';
  return null;
}

export class FakePlanState {
  readonly owners = new Map<string, OwnerRow>();
  /** `${lo}|${hi}` -> started ms. */
  readonly pairs = new Map<string, number>();
  graceDays = 14;
  cooldownDays = 7;
  minVersion: { desktop: string; ios: string } = { desktop: '0.0.0', ios: '0.0.0' };
  private readonly caps = new Map<string, number>();
  /** account_max_active_devices_fallback. */
  defaultCap = 5;

  /** account_max_active_devices of a user's tier (-1 no cap). */
  setDeviceCap(userId: string, cap: number): void {
    this.caps.set(userId, cap);
  }

  deviceCap(userId: string): number {
    return this.caps.get(userId) ?? this.defaultCap;
  }

  minVersionFor(platform: string | null): string {
    const group = platformGroup(platform);
    return group === null ? '0.0.0' : this.minVersion[group];
  }

  private anyMinSet(): boolean {
    return [this.minVersion.desktop, this.minVersion.ios].some((v) => {
      const p = versionParts(v);
      return p !== null && compareParts(p, [0, 0, 0]) > 0;
    });
  }

  /** app_version_ok. */
  versionOk(platform: string | null, version: string | null): boolean {
    if (platformGroup(platform) === null) return !this.anyMinSet();
    const min = versionParts(this.minVersionFor(platform));
    if (min === null || compareParts(min, [0, 0, 0]) === 0) return true;
    const own = versionParts(version);
    return own !== null && compareParts(own, min) >= 0;
  }

  private pairKey(a: string, b: string): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  /** vault_owner_resolve(uid, vault, write, claim). */
  resolve(uid: string, vaultKey: string, write: boolean, claim: boolean, nowMs: number): OwnerAnswer {
    const key = vaultKey.toLowerCase();
    if (write && claim && !this.owners.has(key)) {
      this.owners.set(key, { ownerId: uid, ownerSinceMs: nowMs, graceStartedMs: null, releasedBy: null });
    }
    const row = this.owners.get(key);
    if (row === undefined) return { ownership: 'unowned' };
    const cooldown = this.cooldownDays * DAY_MS;
    if (row.ownerId === null) {
      if (!(write && claim)) return { ownership: 'unowned' };
      this.owners.set(key, { ...row, ownerId: uid, ownerSinceMs: nowMs });
      return { ownership: 'owner', release_after: iso(nowMs + cooldown), shared_until: null };
    }
    const grace = this.graceDays * DAY_MS;
    if (row.ownerId === uid) {
      const shared = row.graceStartedMs === null ? null : row.graceStartedMs + grace;
      return { ownership: 'owner', release_after: iso((row.ownerSinceMs ?? nowMs) + cooldown), shared_until: shared !== null && shared > nowMs ? iso(shared) : null };
    }
    const pair = this.pairKey(row.ownerId, uid);
    let started = row.graceStartedMs;
    if (write) {
      if (!this.pairs.has(pair)) this.pairs.set(pair, nowMs);
      if (started === null) {
        started = nowMs;
        this.owners.set(key, { ...row, graceStartedMs: nowMs });
      }
    }
    const until = Math.min(started ?? nowMs, this.pairs.get(pair) ?? nowMs) + grace;
    if (nowMs < until) return { ownership: 'grace', grace_until: iso(until) };
    return { ownership: 'not_owner', grace_ended_at: iso(until), released: row.releasedBy === uid };
  }

  /** vault_owner_release(vault). */
  release(uid: string, vaultKey: string, nowMs: number): Readonly<Record<string, unknown>> {
    const key = vaultKey.toLowerCase();
    const row = this.owners.get(key);
    if (row === undefined || row.ownerId !== uid) return { released: false, reason: 'not_owner' };
    const retryAfter = (row.ownerSinceMs ?? nowMs) + this.cooldownDays * DAY_MS;
    if (retryAfter > nowMs) return { released: false, reason: 'too_soon', retry_after: iso(retryAfter) };
    this.owners.set(key, { ...row, ownerId: null, ownerSinceMs: null, releasedBy: uid });
    return { released: true };
  }

  /** Test backdating (the SQL tests update the rows directly). */
  patchOwner(vaultKey: string, patch: Partial<OwnerRow>): void {
    const key = vaultKey.toLowerCase();
    const row = this.owners.get(key);
    if (row !== undefined) this.owners.set(key, { ...row, ...patch });
  }

  backdatePairs(byMs: number): void {
    for (const [k, v] of this.pairs) this.pairs.set(k, v - byMs);
  }
}
