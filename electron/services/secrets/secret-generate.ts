import { randomInt } from 'node:crypto';

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
// Symbols that need no quoting in common shells, so a generated value can be typed into a prompt as is.
const SAFE_SYMBOLS = '-_.@%+=:,';

export const GENERATE_MIN_LENGTH = 12;
export const GENERATE_MAX_LENGTH = 128;
export const GENERATE_DEFAULT_LENGTH = 24;

export interface GenerateOptions {
  length?: number;
  symbols?: boolean;
}

export function generateSecret(options: GenerateOptions = {}): string {
  const length = options.length ?? GENERATE_DEFAULT_LENGTH;
  if (!Number.isInteger(length) || length < GENERATE_MIN_LENGTH || length > GENERATE_MAX_LENGTH) {
    throw new Error(`length must be a whole number from ${GENERATE_MIN_LENGTH} to ${GENERATE_MAX_LENGTH}`);
  }
  const groups = [LETTERS, DIGITS, ...(options.symbols === false ? [] : [SAFE_SYMBOLS])];
  const pool = groups.join('');
  // One from each group, the rest from the whole pool, then shuffle.
  const chars = groups.map((g) => g[randomInt(g.length)]);
  while (chars.length < length) chars.push(pool[randomInt(pool.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
