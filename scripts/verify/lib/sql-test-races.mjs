// Two-connection cases of the plan enforcement SQL tests (docs/PLAN_ENFORCEMENT.md 7.1): T4 (two
// inserts for the last team seat) and O9 (two accounts acquire a new lineage). Each side runs in its
// own psql session and holds its transaction open for a moment, so without the database's lock both
// would pass. Fixtures are committed and removed before and after.

import crypto from 'node:crypto';
import { runCommand } from './proc.mjs';
import { DB_URL, findPsql, psql } from './supabase-stack.mjs';

const HOLD_SECONDS = 1;

function id(name) {
  const hex = crypto.createHash('md5').update(`plan-enforcement-race:${name}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const USERS = { owner: id('owner'), r1: id('r1'), r2: id('r2'), a: id('a'), b: id('b') };
const TEAM = id('team');
const LINEAGE = id('lineage');
const USER_LIST = Object.values(USERS).map((u) => `'${u}'`).join(', ');

const CLEANUP_SQL = `
delete from public.personal_vault_owners where vault_key = '${LINEAGE}';
delete from public.teams where id = '${TEAM}';
delete from auth.users where id in (${USER_LIST});
`;

const SETUP_SQL = `
${CLEANUP_SQL}
insert into auth.users (instance_id, id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.name || '@race.plan.test',
       '{}'::jsonb, '{}'::jsonb, now(), now()
  from (values ${Object.entries(USERS).map(([n, u]) => `('${n}', '${u}'::uuid)`).join(', ')}) as u(name, id);
update public.user_profiles set tier_id = (select id from public.tiers where name = 'pro') where id in (${USER_LIST});
insert into public.teams (id, name, slug, owner_id, max_seats, stripe_subscription_id)
values ('${TEAM}', 'Race team', 'plan-race-${TEAM.slice(0, 8)}', '${USERS.owner}', 2, 'sub_race');
insert into public.team_members (team_id, user_id, role) values ('${TEAM}', '${USERS.owner}', 'admin');
`;

function asRole(claims, role) {
  return `select set_config('request.jwt.claims', '${JSON.stringify(claims)}', true);\nset local role ${role};`;
}

async function session(sql, logFile, label) {
  return runCommand(await findPsql(), ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-d', DB_URL, '-f', '-'], {
    input: `begin;\n${sql}\nselect pg_sleep(${HOLD_SECONDS});\ncommit;\n`,
    timeoutMs: 60_000,
    allowFailure: true,
    logFile,
    label,
  });
}

async function seatRace(logFile) {
  const insert = (u) => `${asRole({ role: 'service_role' }, 'service_role')}
insert into public.team_members (team_id, user_id) values ('${TEAM}', '${u}');`;
  const [x, y] = await Promise.all([session(insert(USERS.r1), logFile, 'psql T4 r1'), session(insert(USERS.r2), logFile, 'psql T4 r2')]);
  const oks = [x, y].filter((r) => r.code === 0).length;
  const full = [x, y].filter((r) => r.code !== 0 && /team_full/.test(r.stderr)).length;
  const members = await psql(`select count(*) from public.team_members where team_id = '${TEAM}'`);
  if (oks === 1 && full === 1 && members === '2') return null;
  return `T4: ${oks} inserts passed, ${full} refused with team_full, ${members} members (want 1, 1, 2)`;
}

async function ownerRace(logFile) {
  const acquire = (u, device) => `${asRole({ sub: u, role: 'authenticated' }, 'authenticated')}
select public.vault_session_acquire('${LINEAGE}', '${device}', gen_random_uuid(), 'race', 'macos', '0.18.0',
  'v.conduit', null, null, false, true);`;
  const answers = await Promise.all([
    session(acquire(USERS.a, id('device-a')), logFile, 'psql O9 a'),
    session(acquire(USERS.b, id('device-b')), logFile, 'psql O9 b'),
  ]);
  const ownership = answers.map((r) => {
    const line = r.stdout.split('\n').find((l) => l.includes('"granted"'));
    return line ? JSON.parse(line).ownership : `error: ${r.stderr.trim().split('\n')[0]}`;
  });
  const owners = await psql(`select count(*) from public.personal_vault_owners where vault_key = '${LINEAGE}'
    and owner_id in ('${USERS.a}', '${USERS.b}')`);
  const sorted = [...ownership].sort().join(',');
  if (sorted === 'grace,owner' && owners === '1') return null;
  return `O9: answers ${JSON.stringify(ownership)}, owner rows ${owners} (want one owner and one grace, 1 row)`;
}

/** Runs T4 and O9. Returns {passed, failed}. */
export async function runRaceCases({ log }) {
  const logFile = log.file('races.log');
  const passed = [];
  const failed = [];
  await psql(SETUP_SQL, { logFile });
  try {
    for (const [caseId, run] of [['T4', seatRace], ['O9', ownerRace]]) {
      const problem = await run(logFile);
      if (problem) failed.push(problem);
      else passed.push(caseId);
    }
  } finally {
    await psql(CLEANUP_SQL, { logFile });
  }
  return { passed, failed };
}
