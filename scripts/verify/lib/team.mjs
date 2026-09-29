// Teams on the local Supabase: a team with the test user as owner and admin (team_members; the
// trg_team_member_sync trigger sets user_profiles.is_team_member), primary_team_id set so the app
// finds it, and removal of everything the team's vaults left behind. Plus the app IPC a device needs
// to create and open a team vault: identity key, team_vault_create, team_vault_open.

import { invoke } from './ui.mjs';
import { psql } from './supabase-stack.mjs';

const EMAIL_DOMAIN = 'conduit.local';
const STALE_TEAM_HOURS = 6;
const ROLES = new Set(['admin', 'member']);
let counter = 0;

// Rows whose user FKs have no ON DELETE action would block the test users' deletion, and
// primary_team_id would block the team's own; team_vaults and team_members cascade from teams.
const TEAM_IDS = "string_to_array(:'ids', ',')::uuid[]";
const TEAM_VAULTS = `(select id from public.team_vaults where team_id = any(${TEAM_IDS}))`;
const DELETE_TEAMS_SQL = `begin;
update public.user_profiles set primary_team_id = null where primary_team_id = any(${TEAM_IDS});
delete from public.vault_entries where vault_id in ${TEAM_VAULTS};
delete from public.vault_folder_permissions where vault_id in ${TEAM_VAULTS};
delete from public.vault_locks where vault_id in ${TEAM_VAULTS};
delete from public.vault_folders where vault_id in ${TEAM_VAULTS};
delete from public.teams where id = any(${TEAM_IDS});
commit;
`;

/** Deletes teams and what their vaults left in tables without cascades. */
export async function deleteTeams(ids) {
  const list = ids.filter(Boolean);
  if (list.length === 0) return;
  if (list.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) throw new Error(`Bad team ids ${JSON.stringify(list)}`);
  await psql(DELETE_TEAMS_SQL, { vars: { ids: list.join(',') } });
}

/** Adds (or re-roles) `user` in the team and makes it their primary team. */
export async function addTeamMember(team, user, role = 'member') {
  if (!ROLES.has(role)) throw new Error(`Unknown team role "${role}". Use admin or member`);
  const out = await psql(
    `insert into public.team_members (team_id, user_id, role) values (:'team', :'uid', :'role')
       on conflict (team_id, user_id) do update set role = excluded.role;
     update public.user_profiles set primary_team_id = :'team' where id = :'uid' returning is_team_member;`,
    { vars: { team: team.id, uid: user.id, role } },
  );
  if (out.split('\n').pop() !== 't') throw new Error(`${user.email}: is_team_member did not turn true (got ${JSON.stringify(out)})`);
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
  // A dummy subscription id: the seat trigger (20260929150000) refuses members of a team without one.
  const id = await psql(
    "insert into public.teams (name, slug, owner_id, max_seats, stripe_subscription_id) values (:'name', :'slug', :'owner', :'seats', 'sub_' || :'slug') returning id",
    { vars: { name: teamName, slug, owner: owner.id, seats: String(seats) } },
  );
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`Team insert returned ${JSON.stringify(id)}`);
  const team = { id, name: teamName, slug, ownerId: owner.id };
  run.onCleanup(`delete team ${slug}`, () => deleteTeams([id]));
  await addTeamMember(team, owner, 'admin');
  for (const m of members) await addTeamMember(team, m.user, m.role ?? 'member');
  return team;
}

/** Teams owned by verify users older than a few hours (runs that died before cleanup). */
export async function sweepStaleTeams() {
  const ids = (await psql(
    `select t.id from public.teams t join auth.users u on u.id = t.owner_id
      where u.email like 'verify-%@${EMAIL_DOMAIN}' and u.created_at < now() - interval '${STALE_TEAM_HOURS} hours'`,
  )).split('\n').filter(Boolean);
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
