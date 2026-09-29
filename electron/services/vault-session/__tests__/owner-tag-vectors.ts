// The owner-tag decision table of docs/PLAN_ENFORCEMENT.md 3.4 as golden rows. The expected
// verdicts are written here by hand from the table, never computed by evaluateOwnerTag, so
// owner-tag.test.ts checks the implementation against the spec. The iOS port copies the file.
import { accountHint } from '../../sync/hashing.js';

export const OWNER_TAG_MODULE = 'owner-tag';

const LINEAGE = '0b8f3d52-6c41-4f0e-9d7e-1c2a3b4c5d6e';
const USER = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const OTHER_USER = '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9';
const NOW = 1_760_000_000_000;
const TAG_MS = NOW - 3_600_000;
const MINUTE = 60_000;

const own = accountHint(LINEAGE, USER);
const other = accountHint(LINEAGE, OTHER_USER);

export const OWNER_TAG_NOTES: readonly string[] = [
  'evaluateOwnerTag of docs/PLAN_ENFORCEMENT.md 3.4. Verdicts: allow, sign-in, not-owner-offline.',
  'tag: null when the _sync/owner/account register is absent, else {"a": hint or null}; tagMs is the HLC ms of its provisional sibling.',
  'Hints are account_hint(lineageId, lowercase userId) (hashing.json). ownerCheck is local.json ownerCheck (3.3) or null.',
  'An ownerCheck whose atMs is more than 300000 ms after nowMs is ignored.',
];

export interface OwnerTagRow {
  readonly name: string;
  readonly signedIn: boolean;
  readonly peekConfirmed: boolean;
  readonly userId: string | null;
  readonly lineageId: string;
  readonly tag: { readonly a: string | null } | null;
  readonly tagMs: number;
  readonly ownerCheck: { readonly hint: string; readonly kind: 'owner' | 'grace'; readonly untilMs: number | null; readonly atMs: number } | null;
  readonly nowMs: number;
  readonly expect: 'allow' | 'sign-in' | 'not-owner-offline';
}

type RowInput = Omit<OwnerTagRow, 'lineageId' | 'tagMs' | 'nowMs'>;

const ownerCheck = (hint: string, atMs: number) => ({ hint, kind: 'owner' as const, untilMs: null, atMs });
const graceCheck = (hint: string, untilMs: number, atMs = NOW - MINUTE) => ({ hint, kind: 'grace' as const, untilMs, atMs });

const signedIn = (name: string, peekConfirmed: boolean, rest: Pick<RowInput, 'tag' | 'ownerCheck' | 'expect'> & { userId?: string }): RowInput => ({
  name,
  signedIn: true,
  peekConfirmed,
  userId: rest.userId ?? USER,
  tag: rest.tag,
  ownerCheck: rest.ownerCheck,
  expect: rest.expect,
});

const signedOut = (name: string, rest: Pick<RowInput, 'tag' | 'ownerCheck' | 'expect'>): RowInput => ({
  name,
  signedIn: false,
  peekConfirmed: false,
  userId: null,
  ...rest,
});

const ROWS: readonly RowInput[] = [
  signedIn('signed in, peek ok: tag absent', true, { tag: null, ownerCheck: null, expect: 'allow' }),
  signedIn('signed in, peek ok: tag released', true, { tag: { a: null }, ownerCheck: null, expect: 'allow' }),
  signedIn('signed in, peek ok: tag names this account', true, { tag: { a: own }, ownerCheck: null, expect: 'allow' }),
  signedIn('signed in, peek ok: tag names another account (the server decides)', true, { tag: { a: other }, ownerCheck: null, expect: 'allow' }),
  signedIn('offline: tag absent', false, { tag: null, ownerCheck: null, expect: 'allow' }),
  signedIn('offline: tag released', false, { tag: { a: null }, ownerCheck: null, expect: 'allow' }),
  signedIn('offline: tag names this account', false, { tag: { a: own }, ownerCheck: null, expect: 'allow' }),
  signedIn('offline: tag names another account, no cache', false, { tag: { a: other }, ownerCheck: null, expect: 'not-owner-offline' }),
  signedIn('offline: stale tag, newer owner cache', false, { tag: { a: other }, ownerCheck: ownerCheck(own, TAG_MS + MINUTE), expect: 'allow' }),
  signedIn('offline: newer tag, older owner cache', false, { tag: { a: other }, ownerCheck: ownerCheck(own, TAG_MS - MINUTE), expect: 'not-owner-offline' }),
  signedIn('offline: grace cache still running', false, { tag: { a: other }, ownerCheck: graceCheck(own, NOW + 86_400_000), expect: 'allow' }),
  signedIn('offline: grace cache expired', false, { tag: { a: other }, ownerCheck: graceCheck(own, NOW - 1), expect: 'not-owner-offline' }),
  signedIn('offline: owner cache of another account', false, { tag: { a: other }, ownerCheck: ownerCheck(other, TAG_MS + MINUTE), expect: 'not-owner-offline' }),
  signedIn('offline: owner cache dated in the future is ignored', false, { tag: { a: other }, ownerCheck: ownerCheck(own, NOW + 10 * MINUTE), expect: 'not-owner-offline' }),
  signedIn('offline: mixed-case user id hashes lowercase', false, { tag: { a: own }, ownerCheck: null, expect: 'allow', userId: USER.toUpperCase() }),
  signedOut('signed out: tag absent', { tag: null, ownerCheck: null, expect: 'allow' }),
  signedOut('signed out: tag released', { tag: { a: null }, ownerCheck: null, expect: 'allow' }),
  signedOut('signed out: tag names an account, no cache', { tag: { a: own }, ownerCheck: null, expect: 'sign-in' }),
  signedOut('signed out: owner cache of the tagged account', { tag: { a: own }, ownerCheck: ownerCheck(own, TAG_MS - MINUTE), expect: 'allow' }),
  signedOut('signed out: stale tag, newer owner cache', { tag: { a: other }, ownerCheck: ownerCheck(own, TAG_MS + MINUTE), expect: 'allow' }),
  signedOut('signed out: newer tag, older owner cache', { tag: { a: other }, ownerCheck: ownerCheck(own, TAG_MS - MINUTE), expect: 'sign-in' }),
  signedOut('signed out: a grace cache never opens', { tag: { a: own }, ownerCheck: graceCheck(own, NOW + 86_400_000), expect: 'sign-in' }),
  signedOut('signed out: owner cache dated in the future is ignored', { tag: { a: own }, ownerCheck: ownerCheck(own, NOW + 10 * MINUTE), expect: 'sign-in' }),
];

export function ownerTagRows(): readonly OwnerTagRow[] {
  return ROWS.map((r) => ({ ...r, lineageId: LINEAGE, tagMs: TAG_MS, nowMs: NOW }));
}

export function ownerTagFile(): object {
  return { format: 1, module: OWNER_TAG_MODULE, notes: OWNER_TAG_NOTES, rows: ownerTagRows() };
}
