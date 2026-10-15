import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// One-time (and repeatable) setup of the local Appwrite stack for development and the verify
// harness: installs Appwrite in Docker, adds a mail catcher, creates the console account, the
// `conduit-dev` project, an API key and the app platforms, writes the env file, and deploys the
// schema and the api function. Safe to run again; it only adds what is missing.

export const APPWRITE_VERSION = '2.3.0';
export const HTTP_PORT = 8085;
// CONDUIT_APPWRITE_PROJECT adds another local project (for example an import rehearsal) next to conduit-dev.
export const PROJECT_ID = process.env.CONDUIT_APPWRITE_PROJECT ?? 'conduit-dev';
const CONSOLE_EMAIL = 'dev@conduit.local';
const MAILPIT = 'conduit-appwrite-mailpit';

export function stackDir(): string {
  if (process.env.CONDUIT_APPWRITE_DIR) return process.env.CONDUIT_APPWRITE_DIR;
  const ssd = '/Volumes/SSD Storage/.conduit-dev/appwrite';
  return existsSync(ssd) ? ssd : join(homedir(), '.conduit-dev', 'appwrite');
}

export const envFile = (dir = stackDir()) => join(dir, `${PROJECT_ID}.env`);
const ENDPOINT = `http://localhost:${HTTP_PORT}/v1`;
const SESSION_LIMIT = 100;
const log = (m: string) => console.log(`[appwrite:setup] ${m}`);
const sh = (cmd: string, args: string[], cwd?: string) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });
const quiet = (cmd: string, args: string[]) => {
  try {
    return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
};

function readEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

function setEnvLine(text: string, key: string, value: string): string {
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;
}

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`${ENDPOINT}/health/version`, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}

async function waitHealthy(): Promise<void> {
  for (let i = 0; i < 180; i++) {
    if (await healthy()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Appwrite did not come up within 3 minutes');
}

function install(dir: string): void {
  if (existsSync(join(dir, 'docker-compose.yml'))) return;
  log(`installing Appwrite ${APPWRITE_VERSION} in ${dir}`);
  mkdirSync(dir, { recursive: true });
  sh('docker', [
    'run', '--rm', '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', `${dir}:/usr/src/code/appwrite:rw`,
    '--entrypoint=install', `appwrite/appwrite:${APPWRITE_VERSION}`,
    `--http-port=${HTTP_PORT}`, '--https-port=8445', '--interactive=N', '--database=postgresql', '--domain=localhost',
  ]);
}

const CLICKHOUSE_QUIET = `<clickhouse>
  <logger><level>warning</level></logger>
  <text_log remove="1"/>
  <trace_log remove="1"/>
  <query_log remove="1"/>
  <query_thread_log remove="1"/>
  <query_views_log remove="1"/>
  <part_log remove="1"/>
  <metric_log remove="1"/>
  <asynchronous_metric_log remove="1"/>
  <processors_profile_log remove="1"/>
  <opentelemetry_span_log remove="1"/>
  <session_log remove="1"/>
  <latency_log remove="1"/>
  <error_log remove="1"/>
  <query_metric_log remove="1"/>
  <blob_storage_log remove="1"/>
  <background_schedule_pool_log remove="1"/>
  <asynchronous_insert_log remove="1"/>
  <backup_log remove="1"/>
  <s3queue_log remove="1"/>
  <zookeeper_log remove="1"/>
  <crash_log remove="1"/>
  <filesystem_cache_log remove="1"/>
</clickhouse>
`;

function configure(dir: string): void {
  const envPath = join(dir, '.env');
  let env = readFileSync(envPath, 'utf8');
  env = setEnvLine(env, '_APP_SMTP_HOST', MAILPIT);
  env = setEnvLine(env, '_APP_SMTP_PORT', '1025');
  env = setEnvLine(env, '_APP_SMTP_SECURE', '');
  env = setEnvLine(env, '_APP_FUNCTIONS_RUNTIMES', '"node-22"');
  writeFileSync(envPath, env);
  // ClickHouse (usage stats) otherwise spends a full core writing its own system logs, which slows
  // every API call on a laptop.
  writeFileSync(join(dir, 'clickhouse-quiet.xml'), CLICKHOUSE_QUIET);
  // Functions reach the API on the runtimes network as appwrite-api.
  writeFileSync(
    join(dir, 'docker-compose.override.yml'),
    'services:\n  appwrite:\n    networks:\n      runtimes:\n        aliases: [appwrite-api]\n' +
      '  clickhouse:\n    volumes:\n      - ./clickhouse-quiet.xml:/etc/clickhouse-server/config.d/conduit-quiet.xml:ro\n' +
      // Postgres runs as PID 1 and treats any orphan that exits non-zero (a timed-out health check)
      // as a crashed backend, restarting every connection. An init process reaps those instead.
      '  postgresql:\n    init: true\n' +
      'networks:\n  runtimes:\n    external: true\n',
  );
  if (!quiet('docker', ['network', 'ls', '-q', '-f', 'name=^runtimes$'])) sh('docker', ['network', 'create', 'runtimes']);
  sh('docker', ['compose', 'up', '-d'], dir);
  if (!quiet('docker', ['ps', '-aq', '-f', `name=^${MAILPIT}$`])) {
    sh('docker', ['run', '-d', '--name', MAILPIT, '--restart', 'unless-stopped', '--network', 'appwrite', '-p', '8025:8025', 'axllent/mailpit:v1.27']);
  } else {
    sh('docker', ['start', MAILPIT]);
  }
}

class Console {
  private cookie = '';

  async call(method: string, path: string, body?: unknown, project = 'console'): Promise<{ status: number; json: Record<string, unknown> }> {
    const target: Record<string, string> = project === 'console' ? {} : { 'X-Appwrite-Mode': 'admin' };
    const res = await fetch(`${ENDPOINT}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Appwrite-Project': project, ...target, ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie?.() ?? [];
    const session = set.map((c) => c.split(';')[0]!).filter((c) => c.startsWith('a_session_console'));
    if (session.length) this.cookie = session.join('; ');
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }

  async ensure(method: string, path: string, body: unknown, what: string): Promise<Record<string, unknown>> {
    const r = await this.call(method, path, body);
    if (r.status < 300) {
      log(`created ${what}`);
      return r.json;
    }
    // 409: it exists. 403 organization_creation_prohibited: a self-hosted stack allows one organization.
    if (r.status === 409 || (r.status === 403 && r.json.type === 'organization_creation_prohibited')) return r.json;
    throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  }
}

async function provision(dir: string): Promise<void> {
  const file = envFile(dir);
  const saved = readEnv(file);
  const shared = readEnv(join(dir, 'conduit-dev.env'));
  const consolePassword = saved.CONSOLE_PASSWORD || shared.CONSOLE_PASSWORD || randomBytes(18).toString('base64url');
  const c = new Console();
  // After the first account Appwrite closes console sign-up (501), which means it already exists.
  const signup = await c.call('POST', '/account', { userId: 'unique()', email: CONSOLE_EMAIL, password: consolePassword, name: 'Dev' });
  if (signup.status < 300) log('created console account');
  else if (signup.status !== 409 && signup.status !== 501) throw new Error(`console account: HTTP ${signup.status}`);
  const login = await c.call('POST', '/account/sessions/email', { email: CONSOLE_EMAIL, password: consolePassword });
  if (login.status >= 300) throw new Error(`console sign-in failed (HTTP ${login.status}); delete ${file} only together with the stack`);
  await c.ensure('POST', '/teams', { teamId: 'conduit-org', name: 'Conduit Dev' }, 'console organization');
  await c.ensure('POST', '/projects', { projectId: PROJECT_ID, name: PROJECT_ID === 'conduit-dev' ? 'Conduit Dev' : PROJECT_ID, teamId: 'conduit-org', region: 'default' }, `project ${PROJECT_ID}`);
  for (const p of [
    { platformId: 'localhost', type: 'web', name: 'localhost', hostname: 'localhost' },
    { platformId: 'ios', type: 'apple-ios', name: 'com.conduitapp.ios', key: 'com.conduitapp.ios' },
    { platformId: 'ios-tests', type: 'apple-ios', name: 'com.conduitapp.ios.tests', key: 'com.conduitapp.ios.tests' },
    { platformId: 'ios-uitests', type: 'apple-ios', name: 'com.conduitapp.ios.uitests', key: 'com.conduitapp.ios.uitests' },
  ]) {
    await c.ensure('POST', `/projects/${PROJECT_ID}/platforms`, p, `platform ${p.name}`);
  }
  await c.call('PATCH', `/projects/${PROJECT_ID}/smtp`, { enabled: true, senderName: 'Conduit', senderEmail: 'noreply@conduitdesktop.com', host: MAILPIT, port: 1025 });
  // Same as prod: the default of 10 quietly signs out a user's oldest app session.
  const limit = await c.call('PATCH', '/project/policies/session-limit', { total: SESSION_LIMIT }, PROJECT_ID);
  if (limit.status >= 300) throw new Error(`session limit: HTTP ${limit.status}`);

  let apiKey = saved.APPWRITE_API_KEY;
  if (!apiKey) {
    const key = await c.call('POST', `/projects/${PROJECT_ID}/keys`, {
      keyId: `dev-${randomBytes(4).toString('hex')}`,
      name: 'local dev and verify harness',
      scopes: [
        'users.read', 'users.write', 'sessions.write', 'teams.read', 'teams.write', 'databases.read', 'databases.write',
        'tables.read', 'tables.write', 'rows.read', 'rows.write', 'columns.read', 'columns.write', 'indexes.read', 'indexes.write',
        'files.read', 'files.write', 'buckets.read', 'buckets.write', 'functions.read', 'functions.write', 'execution.read', 'execution.write',
      ],
    });
    if (key.status >= 300) throw new Error(`API key: HTTP ${key.status} ${JSON.stringify(key.json).slice(0, 200)}`);
    apiKey = String(key.json.secret);
    log('created API key');
  }
  const lines = {
    APPWRITE_ENDPOINT: ENDPOINT,
    APPWRITE_PROJECT_ID: PROJECT_ID,
    APPWRITE_API_KEY: apiKey,
    CONDUIT_SERVICE_SECRET: saved.CONDUIT_SERVICE_SECRET || randomBytes(32).toString('hex'),
    CONDUIT_API_ENDPOINT: 'http://appwrite-api/v1',
    // Every local test account shares this Mac's hardware ID, which the abuse check would flag.
    CONDUIT_ABUSE_CHECKS: 'off',
    CONSOLE_EMAIL,
    CONSOLE_PASSWORD: consolePassword,
  };
  writeFileSync(file, `${Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, { mode: 0o600 });
  log(`wrote ${file}`);
}

function deploy(dir: string): void {
  const env = readEnv(envFile(dir));
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  execFileSync(process.execPath, [join(root, 'scripts', 'deploy.ts'), '--seed'], { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = stackDir();
  if (!quiet('docker', ['info', '--format', '{{.ServerVersion}}'])) throw new Error('Docker is not running');
  install(dir);
  configure(dir);
  await waitHealthy();
  await provision(dir);
  deploy(dir);
  log(`ready: ${ENDPOINT} (project ${PROJECT_ID}), mail at http://localhost:8025, console at http://localhost:${HTTP_PORT}`);
}
