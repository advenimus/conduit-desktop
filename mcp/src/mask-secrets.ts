/**
 * Mask !!secret!! values in text to prevent leaking visually-masked secrets through MCP responses.
 *
 * Uses the same regex pattern as src/components/markdown/remarkSecret.ts.
 */

const SECRET_RE = /!!(.+?)!!/g;

export function maskSecrets(text: string): string {
  return text.replace(SECRET_RE, '[REDACTED]');
}
