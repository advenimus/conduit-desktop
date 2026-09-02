#!/usr/bin/env node
/**
 * Give npm's Electron.app a unique Local Network identity so macOS 15+
 * can prompt and list it. Stock Electron is linker-signed as
 * com.github.Electron with no NSLocalNetworkUsageDescription, so it never
 * appears in System Settings and LAN SSH is silently denied.
 *
 * Re-run after every `npm install` (wired from postinstall).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const identity = require('./mac-local-network-identity.cjs');

function log(message) {
  console.log(`[stamp-electron-dev] ${message}`);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout || '';
}

function resolveSigningIdentity() {
  try {
    const out = run('security', ['find-identity', '-v', '-p', 'codesigning']);
    const line = out.split('\n').find((entry) => entry.includes('Apple Development:'));
    const match = line && line.match(/"([^"]+)"/);
    if (match) return match[1];
  } catch {
    /* fall through to ad-hoc */
  }
  log('no Apple Development identity; falling back to ad-hoc sign');
  return '-';
}

function stampElectronApp(appPath) {
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  const binPath = path.join(appPath, 'Contents', 'MacOS', 'Electron');
  if (!fs.existsSync(plistPath) || !fs.existsSync(binPath)) {
    throw new Error(`Electron.app is missing Info.plist or the main executable: ${appPath}`);
  }

  const updates = identity.devInfoPlistUpdates();
  for (const [key, value] of Object.entries(updates)) {
    run('plutil', ['-replace', key, '-string', value, plistPath]);
  }

  identity.writePatchedUuid(binPath, identity.deriveUuidBytes(identity.DEV_BUNDLE_ID));

  const signingId = resolveSigningIdentity();
  // Signing the .app bundle creates a resource seal nested Electron
  // frameworks cannot satisfy. Local Network tracks the main executable,
  // so sign that only and leave nested code as Electron shipped it.
  spawnSync('codesign', ['--remove-signature', appPath], { encoding: 'utf8' });
  spawnSync('xattr', ['-dr', 'com.apple.quarantine', appPath], { encoding: 'utf8' });
  run('codesign', [
    '--force',
    '--sign',
    signingId,
    '--identifier',
    identity.DEV_BUNDLE_ID,
    binPath,
  ]);

  const lsregister =
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  if (fs.existsSync(lsregister)) {
    try {
      run(lsregister, ['-f', appPath]);
    } catch {
      /* Launch Services refresh is best-effort */
    }
  }

  return signingId;
}

function main() {
  if (process.platform !== 'darwin') return;

  const source = path.resolve(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app');
  if (!fs.existsSync(source)) {
    log('Electron.app not found; skip');
    return;
  }

  const dest = identity.devAppInstallPath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  run('ditto', [source, dest]);
  const signingId = stampElectronApp(dest);
  log(`installed ${dest} (${identity.DEV_BUNDLE_ID}), signed with ${signingId}`);
}

module.exports = { main, stampElectronApp, resolveSigningIdentity };

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('[stamp-electron-dev]', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
