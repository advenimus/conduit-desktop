/** A deep link as it may be logged: scheme, host and path only. The fragment carries tokens. */
export function describeDeepLink(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}${u.hash || u.search ? ' (parameters not logged)' : ''}`;
  } catch {
    return '(unparseable link)';
  }
}
