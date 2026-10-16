// npm run appwrite:start | appwrite:stop | appwrite:deploy for the local Appwrite stack.
// First-time setup is npm run appwrite:setup (docs/LOCAL_APPWRITE.md).

import { runCommand } from './verify/lib/proc.mjs';
import { ensureLocalAppwrite, stackDir } from './verify/lib/appwrite-stack.mjs';

const action = process.argv[2];
const log = (m) => console.log(`[appwrite] ${m}`);

if (action === 'start' || action === 'deploy') {
  const env = await ensureLocalAppwrite(log);
  log(`ready at ${env.APPWRITE_ENDPOINT} (project ${env.APPWRITE_PROJECT_ID}); mail at http://localhost:8025`);
} else if (action === 'stop') {
  await runCommand('docker', ['compose', 'stop'], { cwd: stackDir(), timeoutMs: 300_000, label: 'docker compose stop' });
  await runCommand('docker', ['stop', 'conduit-appwrite-mailpit'], { allowFailure: true, label: 'mailpit' });
  log('stopped');
} else {
  console.error('usage: node scripts/appwrite-local.mjs start|stop|deploy');
  process.exit(2);
}
