// Production parity for the local stack: scripts/verify/sql/local-parity.sql (the 'vaults' storage
// bucket and the team members RPC grant). The migrations now create the team-sync RPC with the
// parent_entry_id signature (20260929150000) and the bucket's four storage.objects policies
// (20260929150300); parityProblems still checks both.
// Applied on every run after the migrations, under an advisory lock so parallel runs never replace
// the same function at the same time.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './proc.mjs';

export const PARITY_SQL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sql', 'local-parity.sql');

const PARITY_LOCK_KEY = 7_243_901;
const BUCKET = 'vaults';
const STORAGE_POLICIES = ['Users can delete own vault', 'Users can insert own vault', 'Users can select own vault', 'Users can update own vault'];
const UPSERT_RPC = 'upsert_vault_entry_versioned';
const UPSERT_RPC_ARGS = 23;
// App RPCs (parity) and the team RLS helpers (20260927020444) the signed-in user must be able to run.
const AUTHENTICATED_FUNCTIONS = [
  'public.get_team_members_with_email(uuid)',
  'public.is_team_member(uuid, uuid)',
  'public.is_team_admin(uuid, uuid)',
  'public.is_team_vault_member(uuid, uuid)',
  'public.is_team_vault_admin(uuid, uuid)',
  'public.team_vault_has_members(uuid)',
  'public.shares_team_as_admin(uuid, uuid)',
];

/** Runs local-parity.sql in one transaction behind an advisory lock. */
export async function applyLocalParity({ psqlPath, dbUrl, logFile }) {
  await runCommand(psqlPath, [
    '-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-d', dbUrl,
    '-o', '/dev/null', '-c', `select pg_advisory_xact_lock(${PARITY_LOCK_KEY})`,
    '-f', PARITY_SQL,
  ], { timeoutMs: 120_000, logFile, label: 'psql local-parity.sql' });
}

/** Problems with the parity objects (empty when all are present). `psql(query)` returns -At output. */
export async function parityProblems(psql) {
  const problems = [];
  const bucket = await psql(`select coalesce((select public::text from storage.buckets where id = '${BUCKET}'), 'missing')`);
  if (bucket === 'missing') problems.push(`storage bucket '${BUCKET}' is missing`);
  else if (bucket !== 'false') problems.push(`storage bucket '${BUCKET}' is public`);
  const names = (await psql("select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects'")).split('\n');
  const missing = STORAGE_POLICIES.filter((p) => !names.includes(p));
  if (missing.length > 0) problems.push(`storage.objects policies missing: ${missing.join(', ')} (expected all ${STORAGE_POLICIES.length})`);
  const rpc = await psql(
    `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace ` +
      `where n.nspname = 'public' and p.proname = '${UPSERT_RPC}' and p.pronargs = ${UPSERT_RPC_ARGS} ` +
      `and pg_get_function_identity_arguments(p.oid) like '%p_parent_entry_id uuid'`,
  );
  if (rpc !== '1') problems.push(`public.${UPSERT_RPC} with ${UPSERT_RPC_ARGS} args (ending in p_parent_entry_id) is missing`);
  for (const fn of AUTHENTICATED_FUNCTIONS) {
    const ok = await psql(`select has_function_privilege('authenticated', '${fn}', 'execute')`);
    if (ok !== 't') problems.push(`authenticated cannot execute ${fn}`);
  }
  return problems;
}

export const PARITY_SUMMARY = `bucket ${BUCKET} + ${STORAGE_POLICIES.length} policies, ${UPSERT_RPC}(${UPSERT_RPC_ARGS} args), ${AUTHENTICATED_FUNCTIONS.length} functions executable by authenticated`;
