import type { Ctx } from '../context.ts';

// public.version_parts, app_platform_group, app_min_version, app_any_min_set, app_version_ok.

export type Parts = [number, number, number];

export function versionParts(p: unknown): Parts | null {
  const m = /^\s*v?(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?/.exec(typeof p === 'string' ? p : '');
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

export function compareParts(a: Parts, b: Parts): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}

export function platformGroup(platform: unknown): 'desktop' | 'ios' | null {
  if (platform === 'macos' || platform === 'windows' || platform === 'linux') return 'desktop';
  if (platform === 'ios' || platform === 'ipados') return 'ios';
  return null;
}

async function minVersions(ctx: Ctx): Promise<Record<string, unknown> | null> {
  const v = await ctx.configValue('min_app_version');
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export async function appMinVersion(ctx: Ctx, platform: unknown): Promise<string> {
  const group = platformGroup(platform);
  const v = group ? (await minVersions(ctx))?.[group] : undefined;
  if (v === undefined || v === null) return '0.0.0';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export async function appAnyMinSet(ctx: Ctx): Promise<boolean> {
  const all = await minVersions(ctx);
  if (!all) return false;
  return Object.values(all).some((v) => {
    const parts = versionParts(typeof v === 'string' ? v : JSON.stringify(v));
    return parts !== null && compareParts(parts, [0, 0, 0]) > 0;
  });
}

export async function appVersionOk(ctx: Ctx, platform: unknown, version: unknown): Promise<boolean> {
  if (platformGroup(platform) === null) return !(await appAnyMinSet(ctx));
  const min = versionParts(await appMinVersion(ctx, platform));
  if (min === null || compareParts(min, [0, 0, 0]) === 0) return true;
  const have = versionParts(version);
  if (have === null) return false;
  return compareParts(have, min) >= 0;
}
