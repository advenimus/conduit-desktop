/**
 * Hide !!secret!! values from agents, and put them back when an agent writes.
 *
 * Reads show each secret as a numbered token ([SECRET_1], [SECRET_2], ...) in order of
 * appearance. Writes swap the tokens back for the stored secrets, so an agent can keep or
 * move a secret it was never shown.
 *
 * Uses the same regex pattern as src/components/markdown/remarkSecret.ts.
 */

const SECRET_RE = /!!(.+?)!!/g;
const TOKEN_RE = /\[SECRET_(\d+)\]/g;
const LEGACY_MARKER = '[REDACTED]';
const SECRET_SLOT = '';

export interface RedactedText {
  readonly text: string;
  /** Full `!!value!!` spans; token N is secrets[N - 1]. */
  readonly secrets: readonly string[];
  readonly legacyMarkers: number;
  readonly hasTokenLookalike: boolean;
}

export interface RestoredText {
  readonly text: string;
  readonly secretsRemoved: number;
}

export function redactSecrets(raw: string): RedactedText {
  const secrets: string[] = [];
  const text = raw.replace(SECRET_RE, (span) => {
    secrets.push(span);
    return `[SECRET_${secrets.length}]`;
  });
  const plain = raw.replace(SECRET_RE, '');
  return {
    text,
    secrets,
    legacyMarkers: countOccurrences(plain, LEGACY_MARKER),
    hasTokenLookalike: new RegExp(TOKEN_RE.source).test(plain),
  };
}

export function maskSecrets(text: string): string {
  return redactSecrets(text).text;
}

/**
 * Turn agent-written text back into stored text, using the secrets from `redacted`
 * (the current stored text, redacted). Throws instead of saving anything that would
 * lose a secret or show one as plain text.
 */
export function restoreSecrets(text: string, redacted: RedactedText): RestoredText {
  if (redacted.hasTokenLookalike) {
    throw new Error(
      'The saved text already has plain text that looks like a secret token ([SECRET_n]), so tokens cannot be matched safely. ' +
        'Ask the user to make this change in Conduit.',
    );
  }
  if (countOccurrences(text.replace(SECRET_RE, ''), LEGACY_MARKER) > redacted.legacyMarkers) {
    throw new Error(
      'The new text has [REDACTED], which would save that literal word over a hidden secret. ' +
        'Read the text again and keep the [SECRET_n] tokens where secrets should stay.',
    );
  }

  const used = new Set<number>();
  const restored = text.replace(TOKEN_RE, (token, digits: string) => {
    const index = Number(digits);
    const secret = redacted.secrets[index - 1];
    if (secret === undefined) {
      throw new Error(
        `${token} is not a secret in the current text, which has ${redacted.secrets.length}. ` +
          'Read the text again and use the tokens it shows.',
      );
    }
    used.add(index);
    return secret;
  });

  // A token next to or inside !! markers would change where secrets start and end,
  // and could leave a secret value as plain text.
  if (secretShape(redactSecrets(restored).text) !== secretShape(text)) {
    throw new Error('Each [SECRET_n] token must stand on its own. Do not put it inside or right next to !! markers.');
  }

  return { text: restored, secretsRemoved: redacted.secrets.length - used.size };
}

function secretShape(text: string): string {
  return text.replace(SECRET_RE, SECRET_SLOT).replace(TOKEN_RE, SECRET_SLOT);
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}
