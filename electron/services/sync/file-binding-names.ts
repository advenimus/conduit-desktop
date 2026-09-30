/**
 * Conflict-copy file names (spec 5.8 provider patterns, 5.9 rebind rule): Dropbox
 * `<stem> (conflicted copy ...)` and `<stem> (<name>'s conflicted copy ...)`, Syncthing
 * `<stem>.sync-conflict-*`, OneDrive `<stem>-<HOST>`. `<stem> 2` and `<stem> (1)` are never
 * provider patterns (Finder "Keep Both", Files "Duplicate" and downloads use them too).
 * Case-insensitive; the `.conduit` extension is required. Pure; import through file-binding.ts
 * or copy-scanner.ts.
 */

export const VAULT_EXTENSION = '.conduit';

export type ConflictPattern = 'conflicted-copy' | 'sync-conflict' | 'host-suffix';

const CONFLICTED_COPY_RE = /^ \((?:[^()]*['’]s )?conflicted copy(?: [^()]*)?\)$/i;
const SYNC_CONFLICT_PREFIX = '.sync-conflict-';
const HOST_SEPARATOR = '-';

export function hasVaultExtension(fileName: string): boolean {
  return fileName.length > VAULT_EXTENSION.length && fileName.toLowerCase().endsWith(VAULT_EXTENSION);
}

/** File name without the `.conduit` extension (the whole name when it has none). */
export function stemOf(fileName: string): string {
  return hasVaultExtension(fileName) ? fileName.slice(0, -VAULT_EXTENSION.length) : fileName;
}

/** What follows `stem` in `fileName` (extension removed); null when it is not `<stem><something>.conduit`. */
function suffixAfterStem(fileName: string, stem: string): string | null {
  if (stem === '' || !hasVaultExtension(fileName)) return null;
  const base = stemOf(fileName);
  if (base.length <= stem.length) return null;
  if (base.slice(0, stem.length).toLowerCase() !== stem.toLowerCase()) return null;
  return base.slice(stem.length);
}

/**
 * The provider pattern `fileName` matches as a conflict copy of `<stem>.conduit`, or null.
 * `hostOk` decides whether the token of `<stem>-<token>` counts as a provider host.
 */
export function providerConflictPattern(fileName: string, stem: string, hostOk: (token: string) => boolean): ConflictPattern | null {
  const rest = suffixAfterStem(fileName, stem);
  if (rest === null) return null;
  if (CONFLICTED_COPY_RE.test(rest)) return 'conflicted-copy';
  if (rest.toLowerCase().startsWith(SYNC_CONFLICT_PREFIX)) return 'sync-conflict';
  if (rest.startsWith(HOST_SEPARATOR) && rest.length > HOST_SEPARATOR.length && hostOk(rest.slice(HOST_SEPARATOR.length))) {
    return 'host-suffix';
  }
  return null;
}

/**
 * 5.8 provider conflict patterns (class 3 only): `<stem> (conflicted copy ...)`,
 * `<stem> (<name>'s conflicted copy ...)`, `<stem>.sync-conflict-*`, and `<stem>-<HOST>` only
 * when HOST is in `hostNames` (device names or hostnames from the copy's own presence).
 * `<stem> 2` and `<stem> (1)` never match. Case-insensitive; `.conduit` extension required.
 */
export function isProviderConflictName(fileName: string, stem: string, hostNames: ReadonlySet<string>): boolean {
  const hosts = new Set([...hostNames].map((h) => h.toLowerCase()));
  return providerConflictPattern(fileName, stem, (token) => hosts.has(token.toLowerCase())) !== null;
}

/**
 * Conflict-like for the automatic rebind (5.9): any provider pattern, with `<stem>-<token>`
 * counting for every token, because the OneDrive rename dance uses a host name this device may
 * never have seen (12 row 58). A user rename to `<stem>-<anything>` then asks instead.
 */
export function isConflictLikeName(fileName: string, stem: string): boolean {
  return providerConflictPattern(fileName, stem, () => true) !== null;
}
