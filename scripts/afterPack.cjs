// scripts/afterPack.cjs
// electron-builder afterPack hook:
//   all    — drops other platforms' prebuilt native binaries
//   macOS  — checks the precompiled Liquid Glass icon (light, dark, clear, tinted) is in the bundle
//   Windows — stamps icon + version info via rcedit (signAndEditExecutable is off
//             because winCodeSign extraction fails on self-hosted runners)
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Arch } = require('builder-util');
const identity = require('./mac-local-network-identity.cjs');
const { pruneNativePrebuilds } = require('./prune-native-prebuilds.cjs');
const macIcon = require('./mac-icon.cjs');

exports.default = async function afterPack(context) {
  pruneForeignPrebuilds(context);

  if (context.electronPlatformName === 'darwin') {
    await handleMacOS(context);
  } else if (context.electronPlatformName === 'win32') {
    await handleWindows(context);
  }
};

// ── All platforms: keep only this build's native prebuilds ────────────
function pruneForeignPrebuilds(context) {
  const platform = context.electronPlatformName;
  const resourcesPath = platform === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const nodeModules = path.join(resourcesPath, 'app.asar.unpacked', 'node_modules');
  const removed = pruneNativePrebuilds(nodeModules, platform, Arch[context.arch]);
  console.log(`[afterPack] Removed ${removed.length} prebuilt binaries for other platforms`);
}

// ── macOS: LAN identity and the Liquid Glass icon ─────────────────────
function patchPackagedUuid(appPath, appName) {
  const executable = path.join(appPath, 'Contents', 'MacOS', appName);
  if (!fs.existsSync(executable)) {
    console.warn('[afterPack] main executable not found, skipping LC_UUID patch');
    return;
  }
  identity.writePatchedUuid(executable, identity.deriveUuidBytes(identity.PROD_BUNDLE_ID));
  console.log('[afterPack] Rewrote LC_UUID for Local Network identity');
}

async function handleMacOS(context) {
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  patchPackagedUuid(appPath, appName);
  checkMacIcon(appPath);
}

// The Liquid Glass icon is precompiled (scripts/mac-icon.cjs explains why); electron-builder.yml copies
// Assets.car in and sets CFBundleIconName. Fail loudly: a missing or stale catalog silently ships the
// flat icon, which is what 0.17.0 did when this step compiled with the runner's older actool.
function checkMacIcon(appPath) {
  if (macIcon.stampedHash() !== macIcon.sourceHash()) {
    throw new Error(
      `[afterPack] build/icons/Assets.car was built from a different ${path.basename(macIcon.ICON_SOURCE)}. ` +
      'Run `npm run icons:mac` (Xcode 26+) and commit the results.',
    );
  }
  const packedCatalog = path.join(appPath, 'Contents', 'Resources', 'Assets.car');
  if (!fs.existsSync(packedCatalog)) {
    throw new Error('[afterPack] Assets.car is missing from the app bundle; check mac.extraResources in electron-builder.yml');
  }
  const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
  const iconName = execFileSync('plutil', ['-extract', 'CFBundleIconName', 'raw', '-o', '-', infoPlist], { encoding: 'utf-8' }).trim();
  if (iconName !== macIcon.ICON_NAME) {
    throw new Error(`[afterPack] CFBundleIconName is "${iconName}", expected "${macIcon.ICON_NAME}"`);
  }
  console.log('[afterPack] Liquid Glass icon (Assets.car) is in the bundle and matches its source');
}

// ── Windows: stamp icon + version info with rcedit ────────────────────
// electron-builder's signAndEditExecutable downloads winCodeSign which fails
// on self-hosted Windows runners (symlink privilege error). We keep it disabled
// and call rcedit ourselves here, before NSIS creates the installer.
async function handleWindows(context) {
  const appName = context.packager.appInfo.productFilename;
  const exePath = path.join(context.appOutDir, `${appName}.exe`);

  if (!fs.existsSync(exePath)) {
    console.error(`[afterPack] ${appName}.exe not found at ${exePath}`);
    return;
  }

  const iconPath = path.resolve(__dirname, '../build/icons/icon.ico');
  if (!fs.existsSync(iconPath)) {
    console.error('[afterPack] icon.ico not found, skipping rcedit');
    return;
  }

  const appInfo = context.packager.appInfo;
  const version = appInfo.version;
  const productName = appInfo.productName;

  console.log(`[afterPack] Stamping icon and version into ${appName}.exe...`);

  try {
    const rcedit = require('rcedit');
    await rcedit(exePath, {
      icon: iconPath,
      'version-string': {
        ProductName: productName,
        FileDescription: productName,
        CompanyName: appInfo.companyName || '',
        LegalCopyright: appInfo.copyright || '',
      },
      'file-version': version,
      'product-version': version,
    });
    console.log('[afterPack] Icon and version info stamped successfully');
  } catch (err) {
    console.error('[afterPack] rcedit failed:', err.message);
    throw err; // Fail the build so we notice
  }
}
