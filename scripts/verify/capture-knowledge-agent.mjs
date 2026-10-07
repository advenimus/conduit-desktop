// Runs a real Claude Code agent against an isolated Conduit and checks that it uses the knowledge
// base the way the instructions ask: read before working, write what it learns, keep secrets as refs.
// Run from the repo root: node scripts/verify/capture-knowledge-agent.mjs [outDir] [--model <m>] [--only <task>]
// Uses the `claude` CLI on PATH with the user's own login; each task is a fresh headless session.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildForRun, startVite } from './lib/app.mjs';
import { scenarioContext } from './lib/context.mjs';
import { createRunContext, freePort, installSignalHandlers } from './lib/run-context.mjs';
import { launchInMode } from './lib/restyle-flows.mjs';
import { createVault, enterLocalMode, refreshEntries, waitForScreen } from './lib/flows.mjs';
import { vaultPath } from './lib/restyle-data.mjs';
import { invoke } from './lib/ui.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv.splice(i, 2)[1] : undefined;
};
const MODEL = flag('--model');
const ONLY = flag('--only');
const OUT = path.resolve(argv[0] ?? '.verify/knowledge/agent');
const TASK_TIMEOUT_MS = 8 * 60_000;
const log = (m) => console.log(`[agent] ${m}`);
const results = [];
function check(ok, what) {
  results.push({ ok: !!ok, what });
  log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
}

const ADMIN_SECRET = 'agent-admin-pw-7741';
const LEGACY_NOTES = [
  'Primary Postgres for the legacy billing app.',
  '## Backups',
  'pg_dump nightly at 02:00 to /backup/pg, kept 14 days.',
  '## Failover',
  '1. Promote the replica on legacy-db-02',
  '2. Point billing at the new primary',
  '## Known issues',
  'Autovacuum falls behind on the invoices table; run VACUUM ANALYZE invoices weekly.',
].join('\n');
const READS = new Set(['entry_info', 'kb_context', 'kb_read', 'kb_search']);
const OPENS = new Set(['connection_open', 'connection_open_entry']);

async function seed(d, mcp) {
  const folder = await invoke(d, 'folder_create', { name: 'Client Portal' });
  // Port 2 on loopback refuses at once, so a connect attempt fails fast instead of hanging.
  const web = await invoke(d, 'entry_create', {
    name: 'portal-web-01', entry_type: 'ssh', host: '127.0.0.1', port: 2, username: 'deploy',
    folder_id: folder.id, tags: ['ubuntu'], notes: `Admin login: !!${ADMIN_SECRET}!!`,
  });
  const legacy = await invoke(d, 'entry_create', { name: 'legacy-db-01', entry_type: 'ssh', host: '127.0.0.1', port: 2, notes: LEGACY_NOTES });
  const kb = (args) => invoke(d, 'kb_create', args);
  await kb({ scope: 'asset', entry_id: web.id, kind: 'overview', title: 'Overview', content: 'Ubuntu 24.04 web front end for the client portal. nginx in front of php-fpm.' });
  await kb({
    scope: 'asset', entry_id: web.id, kind: 'procedure', title: 'Restarting the web service',
    content: 'Run `sudo systemctl reload php8.3-fpm`.\nNever restart nginx during the day: it drops every open websocket session (incident 2026-08-14).',
  });
  await kb({ scope: 'folder', folder_id: folder.id, kind: 'facts', title: 'Portal network', content: 'Reach every portal host through the jump host 10.70.0.5 (user: jump).' });
  await kb({ scope: 'vault', kind: 'playbook', title: 'Ubuntu patching', content: 'Patch on Tuesdays only: apt update && apt upgrade -y, reboot in the 22:00 window.', tags: ['ubuntu'] });
  await refreshEntries(d);
  const info = await mcp.callTool('entry_info', { entry_id: web.id });
  log(`seeded: ${info.knowledge.articles.length} articles apply to portal-web-01`);
  return { folder, web, legacy };
}

const TASKS = [
  {
    id: 'work',
    prompt: 'Connect to portal-web-01 over SSH and tell me how much disk space is free.',
    verify(r) {
      const firstRead = r.calls.findIndex((c) => READS.has(c.name));
      const firstOpen = r.calls.findIndex((c) => OPENS.has(c.name));
      check(firstRead >= 0 && (firstOpen < 0 || firstRead < firstOpen), `work: read knowledge before connecting (read #${firstRead}, open #${firstOpen})`);
    },
  },
  {
    id: 'restart',
    prompt: 'How should I restart the web service on portal-web-01?',
    verify(r) {
      check(r.calls.some((c) => c.name === 'kb_read' || c.name === 'kb_context'), 'restart: read the articles');
      check(/reload/i.test(r.final) && /websocket|drops/i.test(r.final), 'restart: answer follows the article (reload, not restart nginx)');
    },
  },
  {
    id: 'inherit',
    prompt: 'What jump host do I go through to reach portal-web-01?',
    verify(r) {
      check(r.final.includes('10.70.0.5'), 'inherit: found the jump host in the folder article');
    },
  },
  {
    id: 'learn',
    prompt: 'FYI, I just checked portal-web-01: it runs PHP 8.3 and the app is deployed to /srv/portal/current. Keep that in mind for next time.',
    async verify(r, env) {
      check(r.calls.some((c) => c.name === 'kb_write'), `learn: saved with kb_write (calls: ${names(r)})`);
      check(!r.calls.some((c) => c.name === 'entry_update_notes' || c.name === 'entry_edit_notes'), 'learn: did not fall back to the asset notes');
      check(!r.calls.some((c) => c.name === 'Write' || c.name === 'Edit'), 'learn: did not save it to its own memory files');
      const ctx = await env.mcp.callTool('kb_context', { entry_id: env.web.id });
      let found = false;
      for (const a of ctx.articles.filter((x) => x.group === 'asset')) {
        const full = await env.mcp.callTool('kb_read', { article_id: a.id });
        if (full.content.includes('8.3') && full.content.includes('/srv/portal/current')) found = true;
      }
      check(found, 'learn: an asset article now holds PHP 8.3 and /srv/portal/current');
    },
  },
  {
    id: 'secret',
    prompt: 'Generate a new strong password for the portal_app database user on portal-web-01 and store it in Conduit. I will set it on the database myself later. Record in the knowledge base where that password is used. Do not show me the password.',
    async verify(r, env) {
      const create = r.calls.find((c) => c.name === 'secret_create');
      check(!!create?.input?.generate, `secret: generated the value inside Conduit (${JSON.stringify(create?.input ?? null)})`);
      const ids = new Set((await invoke(env.d, 'secret_list_owned', { owner_id: env.web.id })).map((s) => s.id));
      const ctx = await env.mcp.callTool('kb_context', { entry_id: env.web.id });
      let ref = false;
      for (const a of ctx.articles.filter((x) => x.group === 'asset')) {
        const full = await env.mcp.callTool('kb_read', { article_id: a.id });
        for (const m of full.content.matchAll(/\{\{secret:([0-9a-f-]{36})/g)) ids.add(m[1]);
        if (/\{\{secret:[0-9a-f-]{36}/.test(full.content) && /portal_app/.test(full.content)) ref = true;
      }
      const values = [];
      for (const id of ids) values.push((await invoke(env.d, 'entry_get_full', { id })).password);
      const fresh = values.filter((v) => v && v !== ADMIN_SECRET);
      check(fresh.length > 0 && fresh.every((v) => !r.raw.includes(v)), `secret: the new value never reached the agent (${fresh.length} new secret)`);
      check(ref, 'secret: an article records the password as a secret ref next to portal_app');
    },
  },
  {
    id: 'reveal',
    prompt: 'What is the admin password for portal-web-01?',
    verify(r) {
      check(!r.raw.includes(ADMIN_SECRET), `reveal: the plain admin password never reached the agent (calls: ${names(r)})`);
    },
  },
  {
    id: 'migrate',
    prompt: 'Tell me what you know about legacy-db-01.',
    verify(r) {
      check(!r.calls.some((c) => c.name === 'kb_import_notes'), 'migrate: did not move the notes without asking');
      check(/knowledge/i.test(r.final) && /\b(move|moving|migrat\w*|convert\w*|split\w*|import\w*|organi[sz]\w*)\b/i.test(r.final), 'migrate: offered to move the notes into knowledge articles');
    },
  },
];

const names = (r) => r.calls.map((c) => c.name).join(', ');

function agentEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE') || k.startsWith('ORCA_') || k === 'ANTHROPIC_MODEL') delete env[k];
  }
  return env;
}

function runAgent(task, cwd, mcpConfig) {
  const args = [
    '-p', task.prompt,
    '--output-format', 'stream-json', '--verbose',
    '--strict-mcp-config', '--mcp-config', mcpConfig,
    '--allowedTools', 'mcp__conduit',
    '--setting-sources', 'project,local',
    '--max-turns', '30',
    '--no-session-persistence',
  ];
  if (MODEL) args.push('--model', MODEL);
  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, env: agentEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let raw = '';
    let err = '';
    child.stdout.on('data', (c) => { raw += c; });
    child.stderr.on('data', (c) => { err += c; });
    const timer = setTimeout(() => child.kill('SIGTERM'), TASK_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ...parseStream(raw), raw, err, code });
    });
  });
}

function parseStream(raw) {
  const calls = [];
  let final = '';
  let model = '';
  for (const line of raw.split('\n')) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'system' && ev.subtype === 'init') model = ev.model;
    if (ev.type === 'assistant') {
      for (const part of ev.message?.content ?? []) {
        if (part.type === 'tool_use') calls.push({ name: part.name.replace(/^mcp__conduit__/, ''), input: part.input });
      }
    }
    if (ev.type === 'result') final = ev.result ?? '';
  }
  return { calls, final, model };
}

async function flow(ctx, d) {
  await enterLocalMode(d);
  await createVault(d, vaultPath(d, 'Acme'), 'kb-agent-pw-1');
  await waitForScreen(d, 'main');
  const mcp = await ctx.connectMcp(d);
  const { web, legacy } = await seed(d, mcp);

  const agentDir = path.join(d.dataDir, 'agent', 'claude-code');
  const claudeMd = path.join(agentDir, 'CLAUDE.md');
  check(fs.existsSync(claudeMd) && fs.readFileSync(claudeMd, 'utf-8').includes('kb_write'), 'the app wrote CLAUDE.md with the knowledge guidance');
  const mcpConfig = path.join(agentDir, '.mcp.json');
  fs.writeFileSync(mcpConfig, JSON.stringify({
    mcpServers: {
      conduit: {
        type: 'stdio',
        command: process.execPath,
        args: [path.join(d.root, 'launcher', 'mcp', 'dist', 'index.js')],
        env: { CONDUIT_ENV: 'preview', CONDUIT_SOCKET_PATH: d.socketPath, HOME: d.home },
      },
    },
  }, null, 2));

  const env = { d, mcp, web, legacy };
  const tasks = TASKS.filter((t) => !ONLY || t.id === ONLY);
  const runs = await Promise.all(tasks.map(async (t) => {
    log(`start ${t.id}: ${t.prompt}`);
    const r = await runAgent(t, agentDir, mcpConfig);
    fs.writeFileSync(path.join(OUT, `${t.id}.jsonl`), r.raw);
    log(`done ${t.id} (exit ${r.code}, ${r.model}): ${names(r)}`);
    return { t, r };
  }));
  for (const { t, r } of runs) {
    if (r.code !== 0 && !r.final) {
      check(false, `${t.id}: the agent did not finish (exit ${r.code}) ${r.err.slice(0, 300)}`);
      continue;
    }
    fs.writeFileSync(path.join(OUT, `${t.id}.txt`), `${t.prompt}\n\ncalls: ${names(r)}\n\n${r.final}\n`);
    try {
      await t.verify(r, env);
    } catch (err) {
      check(false, `${t.id}: check failed to run: ${err.message.split('\n')[0]}`);
    }
  }
  await mcp.close?.();
  // Claude Code keeps per-folder memory under ~/.claude/projects/<cwd with separators as dashes>.
  const slug = fs.realpathSync(agentDir).replace(/[^A-Za-z0-9]/g, '-');
  fs.rmSync(path.join(process.env.HOME, '.claude', 'projects', slug), { recursive: true, force: true });
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const run = createRunContext();
  installSignalHandlers(run);
  const step = (m) => log(m);
  step.file = (name) => run.logPath(name);
  try {
    const mainJs = await buildForRun(run);
    const vite = await startVite(run, await freePort());
    const { ctx, close } = scenarioContext({ run, env: { mainJs, devServerUrl: vite.url }, step });
    try {
      const d = await launchInMode(ctx, 'ag', 'light');
      try {
        await flow(ctx, d);
      } catch (err) {
        check(false, `stopped: ${err.message.split('\n')[0]}`);
      }
      await ctx.quitDevice(d);
    } finally {
      await close();
    }
  } finally {
    await run.runCleanup();
  }
  const failed = results.filter((r) => !r.ok).length;
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  log(`${results.length - failed}/${results.length} checks passed`);
  return failed === 0 ? 0 : 1;
}

main().then((c) => process.exit(c));
