// Promo scene S2: two devices on one vault with three changes to review, Settings > Sync, and the
// Free plan's "Use here instead" dialogs. Needs Docker and the local Supabase.

import fs from 'node:fs';
import path from 'node:path';
import { ensureLocalSupabase, sql } from './supabase.mjs';
import { launchPromoDevice } from './promo-capture.mjs';
import { fillPromo, homeFixtures, installFakeHandlers } from './promo-data.mjs';
import { expandFolders, showHome } from './promo-setup.mjs';
import { setSidebar } from './restyle-data.mjs';
import { readSyncTab, cancelSettings } from './settings-flows.mjs';
import { TAKEOVER_TITLE, closeReview, conflictCount, useHereFromTakeover, waitForDisplaced, waitForEntry, waitForDialog } from './sync-flows.mjs';
import { mainEval, sleep, waitFor } from './ui.mjs';
import { openVaultHere, waitShared } from './scenario-helpers.mjs';

const PW = 'promo-sync-password-1';
const DISPLAY_NAME = 'Alex Rivera';
const HOSTS = { a: 'Studio MacBook Pro', b: 'Office iMac' };
const CONFLICTS = [['db', '10.0.20.40', '10.0.20.44'], ['web2', '10.0.10.24', '10.0.10.34'], ['lb', '10.0.10.20', '10.0.10.21']];

function vaultFile(ctx, dir) {
  fs.mkdirSync(path.join(ctx.cloudDir, dir), { recursive: true });
  return path.join(ctx.cloudDir, dir, 'Acme Infrastructure.conduit');
}

async function newUser(ctx, role) {
  const user = await ctx.createUser(role);
  await sql("update auth.users set raw_user_meta_data = jsonb_set(coalesce(raw_user_meta_data, '{}'::jsonb), '{display_name}', to_jsonb(:'name'::text)) where id = :'uid'", { name: DISPLAY_NAME, uid: user.id });
  const email = role === 'pro' ? 'alex.rivera@acme.example' : 'alex.r@acme.example';
  await sql("update auth.users set email = :'e' where id = :'uid'", { e: email, uid: user.id });
  await sql("update public.user_profiles set display_name = :'name' where id = :'uid'", { name: DISPLAY_NAME, uid: user.id });
  return { ...user, email };
}

async function pair(ctx, role, tag) {
  const user = await newUser(ctx, role);
  const a = await launchPromoDevice(ctx, `${tag}a`, 'dark', { env: { CV_HOSTNAME: HOSTS.a } });
  const b = await launchPromoDevice(ctx, `${tag}b`, 'dark', { env: { CV_HOSTNAME: HOSTS.b } });
  await Promise.all([a, b].map((d) => installFakeHandlers(d, mainEval)));
  await Promise.all([ctx.flows.signIn(a, user), ctx.flows.signIn(b, user)]);
  return { user, a, b };
}

async function proConflicts(ctx, rec) {
  const { a, b } = await pair(ctx, 'pro', 'p2');
  const vault = vaultFile(ctx, 'promo');
  await ctx.flows.createVault(a, vault, PW);
  const { ids } = await fillPromo(a);
  await waitShared(ctx, vault, (rows) => rows.some((r) => r.id === ids.web), 'the demo entries are published');
  await openVaultHere(ctx, b, vault, PW);
  await waitForEntry(b, ids.web, (e) => e !== null, { timeoutMs: 60_000, label: 'the demo entries on the second device' });
  await sleep(1500);
  await Promise.all(CONFLICTS.flatMap(([key, hostA, hostB]) => [ctx.flows.updateEntry(a, ids[key], { host: hostA }), ctx.flows.updateEntry(b, ids[key], { host: hostB })]));
  await waitFor(async () => (await conflictCount(a)) === CONFLICTS.length, { timeoutMs: 60_000, intervalMs: 500, label: 'three conflicts on the first device' });
  await setSidebar(a, 'docked');
  await expandFolders(a);
  await sleep(800);
  await rec.shot(a, { scene: 's2', name: 'sync-review-banner', description: 'Main screen with the sync status "3 to review" and the review banner', targets: [{ label: 'Sync status', text: '3 to review' }, { label: 'Review banner', text: '3 changes from your other devices need review.' }] });
  await mainEval(a, (_, f) => {
    globalThis.__homeFixtures = f;
    return true;
  }, homeFixtures(ids), { label: 'set dashboard fixtures' });
  await showHome(a, { passwords: false });
  await rec.shot(a, { scene: 's2', name: 'home-needs-attention', description: 'Home with the sync review card under Needs attention', targets: [{ label: 'Needs attention', selector: '[data-attention="sync-review"]' }] });
  await ctx.flows.openConflictReview(a);
  await sleep(700);
  await rec.shot(a, { scene: 's2', name: 'review-panel', description: 'Conflict review: pick which value to keep', targets: [{ label: 'Review panel', selector: '[role=dialog][aria-label="Review changes"]' }, { label: 'Use this', text: 'Use this' }] });
  await closeReview(a);
  await readSyncTab(a);
  await sleep(700);
  await rec.shot(a, { scene: 's2', name: 'settings-sync', description: 'Settings > Sync with the vault owner and the devices list', targets: [{ label: 'Multi-device sync', text: 'Multi-device sync' }] });
  await cancelSettings(a).catch(() => {});
  await ctx.quitDevice(a);
  await ctx.quitDevice(b);
}

async function freeTakeover(ctx, rec) {
  const { a, b } = await pair(ctx, 'free', 'p2f');
  const vault = vaultFile(ctx, 'promo-free');
  await ctx.flows.createVault(a, vault, PW);
  for (const [name, host] of [['web-01', '10.0.10.11'], ['db-01', '10.0.20.4'], ['api-01', '10.0.10.12']]) await ctx.flows.addEntry(a, { name, host, port: 22 });
  await sleep(4000);
  const res = await ctx.flows.openVault(b, vault, PW);
  if (res.outcome !== 'dialog') throw new Error(`expected the take-over dialog, got ${res.outcome}`);
  await rec.shot(b, { scene: 's2', name: 'takeover-dialog', description: 'Vault open on another device: the take-over dialog', targets: [{ label: 'Dialog', selector: `[role=dialog][aria-label="${TAKEOVER_TITLE}"]` }] });
  await useHereFromTakeover(b);
  await waitForDisplaced(a, { timeoutMs: 60_000 });
  await rec.shot(a, { scene: 's2', name: 'use-here-instead', description: 'The vault moved to the other device: Use here instead', targets: [{ label: 'Dialog', selector: '[role=dialog]' }, { label: 'Use here instead', text: 'Use here instead' }] });
  await ctx.quitDevice(a);
  await ctx.quitDevice(b);
}

async function s2(ctx, rec) {
  await ensureLocalSupabase(ctx.step);
  await proConflicts(ctx, rec);
  await freeTakeover(ctx, rec).catch((err) => console.log(`[promo] free take-over shots skipped: ${err.message}`));
}

export const SYNC_SCENES = { s2 };
