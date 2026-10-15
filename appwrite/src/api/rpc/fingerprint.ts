import { tableSpec } from '../../schema/tables.ts';
import type { Ctx } from '../context.ts';
import type { Engine } from '../engine.ts';
import { ApiError } from '../errors.ts';
import type { Row } from '../filters.ts';

// Port of conduit-backend POST /api/fingerprint (lib/abuse/fingerprint.ts and detector.ts).

const FPS = tableSpec('device_fingerprints');
const FLAGS = tableSpec('abuse_flags');
const PROFILES = tableSpec('user_profiles');

interface Signal {
  type: string;
  severity: 'info' | 'warning' | 'critical';
  score: number;
  details: Record<string, unknown>;
}

export function scoreAbuse(p: { sharedPrimaryHash: string[]; sameIpUsers: string[]; recentRegistrations: number; ip: string | null }): Signal[] {
  const signals: Signal[] = [];
  const others = p.sharedPrimaryHash.length;
  if (others >= 1 && others <= 2) {
    signals.push({ type: 'device_reuse', severity: 'info', score: 15, details: { other_accounts: p.sharedPrimaryHash, message: `${others} other account(s) on same device` } });
  }
  if (others >= 3) {
    signals.push({ type: 'device_reuse', severity: 'critical', score: 75, details: { other_accounts: p.sharedPrimaryHash, message: `${others} other accounts on same device` } });
  }
  if (p.ip && others >= 3) {
    const both = p.sharedPrimaryHash.filter((u) => p.sameIpUsers.includes(u));
    if (both.length >= 3) {
      signals.push({ type: 'ip_device_correlation', severity: 'critical', score: 25, details: { correlated_accounts: both, message: `${both.length} accounts share same IP and device` } });
    }
  }
  if (p.recentRegistrations >= 5) {
    signals.push({ type: 'rapid_registration', severity: 'critical', score: 60, details: { count: p.recentRegistrations, message: `${p.recentRegistrations} registrations from same IP in 24h` } });
  } else if (p.recentRegistrations >= 3) {
    signals.push({ type: 'rapid_registration', severity: 'warning', score: 30, details: { count: p.recentRegistrations, message: `${p.recentRegistrations} registrations from same IP in 24h` } });
  }
  return signals;
}

const otherUsers = (rows: Row[], uid: string) => [...new Set(rows.map((r) => r.user_id as string).filter((u) => u !== uid))];

/** engine runs as definer. */
export async function submitFingerprint(ctx: Ctx, engine: Engine, args: Record<string, unknown>, scoring = true): Promise<Record<string, unknown>> {
  const uid = ctx.requireUid();
  const fingerprint = args.fingerprint_hash;
  const primary = args.primary_hash;
  if (typeof fingerprint !== 'string' || !fingerprint || typeof primary !== 'string' || !primary) {
    throw new ApiError('22023', 'fingerprint_hash and primary_hash are required');
  }
  const ip = ctx.caller.ip ?? null;
  const now = ctx.uow.nowIso();
  const values: Row = {
    primary_hash: primary,
    ip_address: ip,
    platform: typeof args.platform === 'string' ? args.platform.slice(0, 32) : null,
    app_version: typeof args.app_version === 'string' ? args.app_version.slice(0, 64) : null,
    last_seen_at: now,
  };
  const existing = await ctx.uow.first(FPS, [
    { column: 'user_id', op: 'eq', value: uid },
    { column: 'fingerprint_hash', op: 'eq', value: fingerprint },
  ]);
  if (existing) await engine.updateRow(FPS, existing, values);
  else await engine.insertRow(FPS, { user_id: uid, fingerprint_hash: fingerprint, ...values });

  const samePrimary = otherUsers(await ctx.uow.list(FPS, [{ column: 'primary_hash', op: 'eq', value: primary }]), uid);
  const sameIp = ip ? otherUsers(await ctx.uow.list(FPS, [{ column: 'ip_address', op: 'eq', value: ip }]), uid) : [];
  const dayAgo = new Date(ctx.uow.now - 86_400_000).toISOString();
  const recent = ip
    ? (await ctx.uow.list(PROFILES, [
        { column: 'registration_ip', op: 'eq', value: ip },
        { column: 'created_at', op: 'gte', value: dayAgo },
      ])).length
    : 0;

  const signals = scoring ? scoreAbuse({ sharedPrimaryHash: samePrimary, sameIpUsers: sameIp, recentRegistrations: recent, ip }) : [];
  let total = 0;
  let suspended = false;
  const profile = await ctx.uow.get(PROFILES, uid);
  if (signals.length > 0) {
    for (const s of signals) await engine.insertRow(FLAGS, { user_id: uid, flag_type: s.type, severity: s.severity, details: s.details });
    total = signals.reduce((sum, s) => sum + s.score, 0);
    suspended = total >= 100;
    if (profile) {
      await engine.updateRow(PROFILES, profile, {
        abuse_score: total,
        is_suspended: suspended,
        suspended_reason: suspended ? 'Account suspended due to abuse detection. Contact support for assistance.' : null,
      });
    }
  }
  if (args.event_type === 'registration' && ip) {
    const current = await ctx.uow.get(PROFILES, uid);
    if (current) await engine.updateRow(PROFILES, current, { registration_ip: ip, registration_fingerprint: primary });
  }
  return { registered: true, abuse_score: total, suspended, signals_detected: signals.length };
}
