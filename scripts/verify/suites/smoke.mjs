// Proves the harness: isolated devices, sign-in, vault create in the run's cloud folder, local
// mode, IPC entry edits, an MCP client on the device socket, screenshots and clean shutdown.

import fs from 'node:fs';
import path from 'node:path';

const VAULT_PASSWORD = 'verify-smoke-password-1';

async function twoDevices(ctx) {
  const { flows, ui } = ctx;
  const user = await ctx.createUser('free');
  ctx.step(`created Free user ${user.email}`);

  const [a, b] = await Promise.all([ctx.launchDevice('a'), ctx.launchDevice('b')]);
  await Promise.all([flows.waitForScreen(a, 'auth'), flows.waitForScreen(b, 'auth')]);
  await ctx.shot(a, 'sign-in-screen');

  const who = await flows.signIn(a, user);
  ctx.checkEqual(who, { email: user.email, tier: 'free' }, 'device a is signed in as the Free test user');
  ctx.step(`device a signed in (${who.tier})`);
  await ctx.shot(a, 'hub-signed-in');

  const vaultPath = path.join(ctx.cloudDir, 'Smoke.conduit');
  await flows.createVault(a, vaultPath, VAULT_PASSWORD);
  ctx.check(fs.existsSync(vaultPath), `vault file exists at ${vaultPath}`);
  const sync = await ui.readSyncState(a);
  ctx.check(sync.vault?.shared === true, `the cloud-folder vault counts as shared (sync.vault=${JSON.stringify(sync.vault)})`);
  ctx.checkEqual(sync.vault?.fileName, 'Smoke.conduit', 'sync state names the open vault');
  const leases = await ctx.waitFor(async () => {
    const rows = await ctx.leaseRows(user.email);
    return rows.some((r) => r.status === 'active') ? rows : null;
  }, { timeoutMs: 20_000, label: 'an active device lease for the Free user' });
  ctx.step(`vault created; ${leases.length} lease row(s), device limit ${JSON.stringify(sync.deviceLimit)}`);
  await ctx.shot(a, 'vault-created');

  await flows.enterLocalMode(b);
  const hubText = await ui.bodyText(b);
  ctx.check(hubText.includes('Open Vault File') && hubText.includes('New Vault'), 'device b shows the vault hub actions');
  await ctx.shot(b, 'hub-local-mode');
}

async function ipcAndMcp(ctx) {
  const { flows } = ctx;
  const device = await ctx.launchDevice('m');
  await flows.enterLocalMode(device);
  await flows.createVault(device, path.join(ctx.cloudDir, 'SmokeLocal.conduit'), VAULT_PASSWORD);

  const entry = await flows.addEntry(device, { name: 'Smoke host', host: '10.1.2.3' });
  ctx.check(typeof entry?.id === 'string', 'entry_create returned an entry id');
  await flows.updateEntry(device, entry.id, { name: 'Smoke host renamed' });
  ctx.step(`entry ${entry.id} created and renamed through IPC`);

  const mcp = await ctx.connectMcp(device);
  const tools = await mcp.listTools();
  ctx.check(tools.some((t) => t.name === 'entry_list'), `MCP lists entry_list (${tools.length} tools)`);
  const listed = await mcp.callTool('entry_list', {});
  const names = JSON.stringify(listed);
  ctx.check(names.includes('Smoke host renamed'), `MCP entry_list sees the renamed entry: ${names.slice(0, 300)}`);
  ctx.step('MCP client on the device socket sees the IPC edit');

  await flows.deleteEntry(device, entry.id);
  const remaining = await flows.listEntries(device);
  ctx.check(!remaining.some((e) => e.id === entry.id), 'entry_delete removed the entry');
  await ctx.shot(device, 'after-ipc-edits');
}

export default {
  id: 'smoke',
  title: 'Harness smoke test',
  scenarios: [
    { id: 'two-devices', title: 'Free user creates a cloud-folder vault; a second device in local mode shows the hub', run: twoDevices },
    { id: 'ipc-and-mcp', title: 'Local-mode device: entry create/edit/delete over IPC, seen by an MCP client', run: ipcAndMcp },
  ],
};
