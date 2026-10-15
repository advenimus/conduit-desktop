// Teams on the local Appwrite: a team with the test user as owner and admin (team_members; the
// membership trigger sets user_profiles.is_team_member), primary_team_id set so the app finds it,
// and removal of the team with everything its vaults left behind (the api cascades). Plus the app
// IPC a device needs to create and open a team vault: identity key, team_vault_create, team_vault_open.

import { invoke } from './ui.mjs';
import { db, rows, staleTestUsers, updateRows } from './backend.mjs';

const ROLES = new Set(['admin', 'member']);
let counter = 0;

function must(res, what) {
  if (res.error) throw new Error(`${what}: ${res.error.code} ${res.error.message}`);
  return res.data;
}

/** Deletes teams; their vaults, members and vault rows go with them. */
export async function deleteTeams(ids) {
  const list = ids.filter(Boolean);
  if (list.length === 0) return;
  if (list.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) throw new Error(`Bad team ids ${JSON.stringify(list)}`);
  // primary_team_id has no ON DELETE action, so it would block the team's deletion.
  must(await db().from('user_profiles').update({ primary_team_id: null }).in('primary_team_id', list), 'clear primary_team_id');
  must(await db().from('teams').delete().in('id', list), 'delete teams');
}

/** Adds (or re-roles) `user` in the team and makes it their primary team. */
export async function addTeamMember(team, user, role = 'member') {
  if (!ROLES.has(role)) throw new Error(`Unknown team role "${role}". Use admin or member`);
  must(await db().from('team_members').upsert({ team_id: team.id, user_id: user.id, role }, { onConflict: 'team_id, user_id' }), 'team member');
  const [profile] = await updateRows('user_profiles', { primary_team_id: team.id }, { id: user.id });
  if (profile?.is_team_member !== true) throw new Error(`${user.email}: is_team_member did not turn true (got ${JSON.stringify(profile)})`);
}

/**
 * Creates team "<name>" owned by `owner` (admin), plus `members` [{user, role}]. Set the users'
 * plan with createUser('team'). The team is removed at cleanup, before the users are. Create it
 * before signIn, or call invoke(d, 'auth_refresh') after, so the app reads primary_team_id.
 * Returns {id, name, slug, ownerId}.
 */
export async function createTeam(run, owner, { name, seats = 5, members = [] } = {}) {
  counter += 1;
  const slug = `verify-${run.runId}-${counter}`.toLowerCase();
  const teamName = name ?? `Verify team ${run.shortId}-${counter}`;
  // A dummy subscription id: the seat rule refuses members of a team without one.
  const [row] = must(
    await db().from('teams').insert({ name: teamName, slug, owner_id: owner.id, max_seats: seats, stripe_subscription_id: `sub_${slug}` }).select('id'),
    'team insert',
  );
  const team = { id: row.id, name: teamName, slug, ownerId: owner.id };
  run.onCleanup(`delete team ${slug}`, () => deleteTeams([row.id]));
  await addTeamMember(team, owner, 'admin');
  for (const m of members) await addTeamMember(team, m.user, m.role ?? 'member');
  return team;
}

/** Teams owned by verify users older than a few hours (runs that died before cleanup). */
export async function sweepStaleTeams() {
  const owners = (await staleTestUsers()).map((u) => u.id);
  const ids = [];
  for (const owner of owners) ids.push(...(await rows('teams', { owner_id: owner }, { columns: 'id' })).map((t) => t.id));
  await deleteTeams(ids);
  return ids.length;
}

/** Makes sure the signed-in device has an identity key (identity_key_generate). Returns {created, recoveryPassphrase}. */
export async function ensureIdentityKey(device) {
  if (await invoke(device, 'identity_key_exists')) return { created: false, recoveryPassphrase: null };
  const res = await invoke(device, 'identity_key_generate', undefined, { timeoutMs: 60_000 });
  if (!res?.recoveryPassphrase) throw new Error(`${device.name}: identity_key_generate returned no recovery passphrase`);
  return { created: true, recoveryPassphrase: res.recoveryPassphrase };
}

/** team_vault_create through the app (identity key first). Returns the vault info ({id, name, ...}). */
export async function createTeamVault(device, team, name, { description } = {}) {
  await ensureIdentityKey(device);
  const vault = await invoke(device, 'team_vault_create', { name, teamId: team.id, description: description ?? null }, { timeoutMs: 60_000 });
  if (!vault?.id) throw new Error(`${device.name}: team_vault_create returned ${JSON.stringify(vault)}`);
  return vault;
}

/**
 * team_vault_open through the app IPC. The renderer is not told; for the UI path dispatch
 * 'conduit:team-vault-unlock' with {id, name} (what the sidebar and hub do) instead.
 */
export function openTeamVault(device, teamVaultId) {
  return invoke(device, 'team_vault_open', { teamVaultId }, { timeoutMs: 60_000 });
}
